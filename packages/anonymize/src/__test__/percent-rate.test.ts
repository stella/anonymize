/**
 * Regression tests for the percentage / financial-rate
 * regex. The pattern surfaces `N%` and `N.NNN%` values
 * because in legal text they fingerprint specific debt
 * instruments and tax brackets even though they are not
 * classically personally identifying on their own.
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
  workspaceId: "percent-rate-test",
};

const detect = async (text: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

describe("percent / rate regex", () => {
  test("interest-rate forms (3.875%, 5.000%, 0%) are captured", async () => {
    const text =
      "3.875% Senior Notes due 2027; 5.000% Senior Notes due 2030; " +
      "0.25% Convertible Notes due 2024; 0% Convertible Notes due 2026.";
    const entities = await detect(text);
    const percents = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    for (const expected of ["3.875%", "5.000%", "0.25%", "0%"]) {
      expect(percents.has(expected)).toBe(true);
    }
  });

  test("integer percentages without decimals are captured", async () => {
    const text = "The 15% deductible applies. A 90% threshold is required.";
    const entities = await detect(text);
    const fifteen = entities.find((e) => e.text === "15%");
    const ninety = entities.find((e) => e.text === "90%");
    expect(fifteen?.label).toBe("monetary amount");
    expect(ninety?.label).toBe("monetary amount");
  });

  test("trailing % is required (bare decimals are not matched)", async () => {
    const text = "The ratio 0.375 of total notes is reserved.";
    const entities = await detect(text);
    const bare = entities.find((e) => e.text === "0.375");
    expect(bare).toBeUndefined();
  });
});
