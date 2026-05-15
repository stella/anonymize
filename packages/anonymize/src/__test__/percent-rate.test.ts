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
import type { PipelineContext } from "../context";
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

let dictionariesPromise: ReturnType<typeof loadTestDictionaries> | undefined;
const getDictionaries = () => {
  dictionariesPromise ??= loadTestDictionaries();
  return dictionariesPromise;
};

let sharedContext: PipelineContext | undefined;
const getContext = (): PipelineContext => {
  sharedContext ??= createPipelineContext();
  return sharedContext;
};

const detect = async (text: string): Promise<Entity[]> => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText: text,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context: getContext(),
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

  test("decimal comma, signed, and spaced percent forms are captured whole", async () => {
    const text = "The 3,875% notes, -0,5 % floor, and 21 % threshold apply.";
    const entities = await detect(text);
    const percents = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    for (const expected of ["3,875%", "-0,5 %", "21 %"]) {
      expect(percents.has(expected)).toBe(true);
    }
    expect(percents.has("875%")).toBe(false);
    expect(percents.has("5 %")).toBe(false);
  });

  test("grouped percentage values are captured whole", async () => {
    const text = "The penalty rate is 1,000.25% of the reference amount.";
    const entities = await detect(text);
    const grouped = entities.find((e) => e.text === "1,000.25%");
    expect(grouped?.label).toBe("monetary amount");
  });

  test("written-out percentages paired with numerals are redacted together", async () => {
    const text =
      "Ownership thresholds are fifty percent (50%) and sixty-five percent (65%).";
    const entities = await detect(text);
    const spans = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    expect(spans.has("fifty percent (50%)")).toBe(true);
    expect(spans.has("sixty-five percent (65%)")).toBe(true);
  });

  test("written percentages cover zero, hundred, and unhyphenated compounds", async () => {
    const text =
      "The limits are zero percent (0%), one hundred percent (100%), " +
      "and twenty five percent (25%).";
    const entities = await detect(text);
    const spans = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    expect([...spans].some((span) => span.includes("zero percent (0%)"))).toBe(
      true,
    );
    expect(
      [...spans].some((span) => span.includes("one hundred percent (100%)")),
    ).toBe(true);
    expect(spans.has("twenty five percent (25%)")).toBe(true);
  });

  test("single-percent ranges are captured as complete spans", async () => {
    const text = "The margin may vary from 5-10% or 5 – 10%.";
    const entities = await detect(text);
    const spans = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    expect(spans.has("5-10%")).toBe(true);
    expect(spans.has("5 – 10%")).toBe(true);
    expect(spans.has("10%")).toBe(false);
  });

  test("over-precise decimal rates do not produce fractional-tail matches", async () => {
    const text = "The notes accrue at 0.12345% and 3,87500%.";
    const entities = await detect(text);
    const spans = new Set(
      entities.filter((e) => e.label === "monetary amount").map((e) => e.text),
    );
    expect(spans.has("12345%")).toBe(false);
    expect(spans.has("87500%")).toBe(false);
  });

  test("trailing % is required (bare decimals are not matched)", async () => {
    const text = "The ratio 0.375 of total notes is reserved.";
    const entities = await detect(text);
    const bare = entities.find((e) => e.text === "0.375");
    expect(bare).toBeUndefined();
  });
});
