/**
 * Regression tests for the US ZIP+4 regex. Bare ZIP5
 * (`\d{5}`) is too generic to emit on its own and is
 * intentionally handled by address-seed clustering;
 * the hyphenated ZIP+4 shape is distinctive enough to
 * fire as a standalone address.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "us-zip-regex-test",
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

describe("US ZIP+4 regex", () => {
  test("ZIP+4 inside a US notice address fires as address", async () => {
    const text = "650 Page Mill Road\nPalo Alto, CA 94304-1050\nAttn: Counsel";
    const entities = await detect(text);
    const zip = entities.find(
      (e) => e.label === "address" && e.text === "94304-1050",
    );
    expect(zip).toBeDefined();
  });

  test("bare ZIP5 not absorbed by ZIP+4 lookaround", async () => {
    // The pattern requires a hyphen + four digits; a
    // standalone five-digit number must not match.
    const text = "Order number 94301 was confirmed.";
    const entities = await detect(text);
    const zip = entities.find((e) => e.text.includes("94301"));
    expect(zip).toBeUndefined();
  });

  test("ZIP+4 in mid-sentence prose is captured", async () => {
    const text =
      "Notices shall be delivered to 100 Main St, Springfield, IL 62701-1234 at all times.";
    const entities = await detect(text);
    const zip = entities.find(
      (e) => e.label === "address" && e.text === "62701-1234",
    );
    expect(zip).toBeDefined();
  });
});
