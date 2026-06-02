/**
 * Regression tests for the Chinese RIC (Resident Identity Card)
 * recognizer. The stdnum pattern is broad ([A-Z0-9]{15,18}) so the
 * checksum + birth-date validator is what keeps unrelated 15-18-character
 * alphanumeric strings (order numbers, case references) from getting
 * tagged as identifiers.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, Entity, PipelineConfig } from "../types";
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
  workspaceId: "cn-ric-regex-test",
};

let dictionariesPromise: Promise<Dictionaries> | undefined;
const getDictionaries = (): Promise<Dictionaries> => {
  dictionariesPromise ??= loadTestDictionaries();
  return dictionariesPromise;
};

let sharedContext: PipelineContext | undefined;
const getContext = (): PipelineContext => {
  sharedContext ??= createPipelineContext();
  return sharedContext;
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context: getContext(),
  });
};

describe("CN RIC 18-digit national identifier", () => {
  test("valid 18-digit RIC with numeric check digit is tagged", async () => {
    // Encodes birth 1963-05-21; passes MOD 11-2 checksum.
    const text = "ID number 120102196305211080 was presented.";
    const entities = await detect(text);
    const hit = entities.find((e) => e.text.includes("120102196305211080"));
    expect(hit).toBeDefined();
    expect(hit?.label).toBe("national identification number");
  });

  test("valid 18-digit RIC with X check digit is tagged", async () => {
    // Encodes birth 1953-03-17; check digit is the letter X.
    const text = "Citizen 51010319530317097X signed the agreement.";
    const entities = await detect(text);
    const hit = entities.find((e) => e.text.includes("51010319530317097X"));
    expect(hit).toBeDefined();
    expect(hit?.label).toBe("national identification number");
  });

  test("18-digit number with an invalid birth date is not tagged", async () => {
    // Digits 7-14 = 20102800 — no month 28 — must be rejected by the
    // validator's date check.
    const text = "Reference number 284301201028003001 in the appendix.";
    const entities = await detect(text);
    const spurious = entities.find((e) =>
      e.text.includes("284301201028003001"),
    );
    expect(spurious).toBeUndefined();
  });

  test("18-digit number with a bad MOD 11-2 checksum is not tagged", async () => {
    // Real birth date (1968-03-04) but deliberately wrong final digit;
    // the validator must reject on checksum.
    const text = "Order 110221196803042210 was processed.";
    const entities = await detect(text);
    const spurious = entities.find((e) =>
      e.text.includes("110221196803042210"),
    );
    expect(spurious).toBeUndefined();
  });
});
