import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import {
  DEFAULT_ENTITY_LABELS,
  DETECTION_SOURCES,
  ENTITY_CAPABILITIES,
  ENTITY_SELECTIONS,
  type EntityCapability,
} from "../constants";

type LabeledEntry = {
  label: string;
};

const isLabeledEntries = (value: unknown): value is LabeledEntry[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "label" in entry &&
      typeof entry.label === "string",
  );

const loadNativeRegexTable = async (): Promise<LabeledEntry[]> => {
  const value: unknown = await Bun.file(
    new URL(
      "../../../../crates/anonymize-adapter-contract/src/assemble/native-regex-table.json",
      import.meta.url,
    ),
  ).json();
  if (!isLabeledEntries(value)) {
    throw new TypeError("native regex table has an invalid shape");
  }
  return value;
};

const loadTriggerLabels = async (): Promise<string[]> => {
  const configDirectory = new URL(
    "../../../../packages/data/config/",
    import.meta.url,
  );
  const entries = await readdir(configDirectory, { withFileTypes: true });
  const labels: string[] = [];

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith("triggers.") ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    const value: unknown = await Bun.file(
      new URL(entry.name, configDirectory),
    ).json();
    if (!isLabeledEntries(value)) {
      throw new TypeError(`${entry.name} has an invalid trigger shape`);
    }
    for (const { label } of value) {
      labels.push(label);
    }
  }

  return labels;
};

describe("entity capabilities", () => {
  test("derives the default label list from the manifest", () => {
    const manifestDefaults: readonly string[] = ENTITY_CAPABILITIES.filter(
      ({ selection }) => selection === ENTITY_SELECTIONS.DEFAULT,
    ).map(({ label }) => label);

    expect(manifestDefaults).toEqual(DEFAULT_ENTITY_LABELS);
    expect(DEFAULT_ENTITY_LABELS).toHaveLength(22);
  });

  test("defines each label and detection source once", () => {
    const labels = new Set<string>();

    for (const capability of ENTITY_CAPABILITIES) {
      expect(labels.has(capability.label)).toBe(false);
      labels.add(capability.label);
      expect(capability.detectionSources.length).toBeGreaterThan(0);
      expect(new Set(capability.detectionSources).size).toBe(
        capability.detectionSources.length,
      );
    }
  });

  test("accounts for every native regex label", async () => {
    const nativeRegexTable = await loadNativeRegexTable();
    const capabilityByLabel = new Map<string, EntityCapability>(
      ENTITY_CAPABILITIES.map((capability) => [capability.label, capability]),
    );

    for (const { label } of nativeRegexTable) {
      const capability = capabilityByLabel.get(label);
      expect(
        capability,
        `missing capability for regex label: ${label}`,
      ).toBeDefined();
      expect(capability?.detectionSources).toContain(DETECTION_SOURCES.REGEX);
    }
  });

  test("accounts for every configured trigger label", async () => {
    const triggerLabels = await loadTriggerLabels();
    const capabilityByLabel = new Map<string, EntityCapability>(
      ENTITY_CAPABILITIES.map((capability) => [capability.label, capability]),
    );

    for (const label of triggerLabels) {
      const capability = capabilityByLabel.get(label);
      expect(
        capability,
        `missing capability for trigger label: ${label}`,
      ).toBeDefined();
      expect(capability?.detectionSources).toContain(DETECTION_SOURCES.TRIGGER);
    }
  });

  test("keeps network identifiers explicitly opt-in", () => {
    const optInLabels = ENTITY_CAPABILITIES.filter(
      ({ selection }) => selection === ENTITY_SELECTIONS.OPT_IN,
    ).map(({ label }) => label);

    expect(optInLabels).toEqual(["ip address", "mac address", "url"]);
  });

  test("reports dictionary-backed addresses as deny-list detections", () => {
    const address = ENTITY_CAPABILITIES.find(
      ({ label }) => label === "address",
    );

    expect(address?.detectionSources).toContain(DETECTION_SOURCES.DENY_LIST);
  });
});
