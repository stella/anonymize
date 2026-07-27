/**
 * Standalone street detection.
 *
 * `standaloneStreetDetection` is off by default. When
 * enabled it accepts a street-type word with a house
 * number directly beside it, in either order, with no
 * known-city anchor. A bare street name never fires.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const baseConfig: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "standalone-street-test",
  dictionaries,
};

const standaloneConfig: PipelineConfig = {
  ...baseConfig,
  standaloneStreetDetection: "houseNumberAnchored",
  workspaceId: "standalone-street-test-on",
};

const addresses = async (
  config: PipelineConfig,
  fullText: string,
): Promise<NativePipelineEntity[]> => {
  const entities = await detectNative(config, fullText);
  return entities.filter((entity) => entity.label === "address");
};

describe("standalone street detection", () => {
  test("is off by default", async () => {
    for (const text of [
      "14 Rue de la Paix",
      "14 Rue de la Paix, Zzzqqx",
      "123 Main Street",
    ]) {
      expect(await addresses(baseConfig, text)).toEqual([]);
    }
  });

  test("a known-city anchor still yields an address by default", async () => {
    const found = await addresses(baseConfig, "14 Rue de la Paix, Paris");
    expect(
      found.some(
        (entity) =>
          entity.text.includes("Rue de la Paix") &&
          entity.text.includes("Paris"),
      ),
    ).toBe(true);
  });

  test("detects a house number before the street type", async () => {
    const found = await addresses(standaloneConfig, "14 Rue de la Paix");
    expect(found.some((entity) => entity.text === "14 Rue de la Paix")).toBe(
      true,
    );
  });

  test("detects a house number after the street type", async () => {
    const found = await addresses(standaloneConfig, "Hauptstraße 5");
    expect(found.some((entity) => entity.text === "Hauptstraße 5")).toBe(true);
  });

  test("detects an English street with a leading house number", async () => {
    const found = await addresses(standaloneConfig, "123 Main Street");
    expect(found.some((entity) => entity.text === "123 Main Street")).toBe(
      true,
    );
  });

  test("a bare street name with no house number does not fire", async () => {
    const found = await addresses(standaloneConfig, "Main Street");
    expect(found.some((entity) => entity.text.includes("Main Street"))).toBe(
      false,
    );
  });

  test("a standalone street span stops at the prose after the street name", async () => {
    const found = await addresses(
      standaloneConfig,
      "Our office at 14 Rue de la Paix are closed on Monday.",
    );
    const address = found.find((entity) => entity.text.includes("Rue de la"));
    expect(address?.text).toBe("14 Rue de la Paix");
  });
});
