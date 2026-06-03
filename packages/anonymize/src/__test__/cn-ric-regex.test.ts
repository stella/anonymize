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

  test("valid 18-digit RIC with lowercase x check digit is tagged", async () => {
    // Real-world IDs are commonly written with lowercase `x`; the
    // pattern must accept it and the stdnum validator's compact step
    // normalises the case for the checksum.
    const text = "Citizen 51010319530317097x signed the agreement.";
    const entities = await detect(text);
    const hit = entities.find((e) => e.text.includes("51010319530317097x"));
    expect(hit).toBeDefined();
    expect(hit?.label).toBe("national identification number");
  });

  test("RIC preceded by a CJK label is tagged", async () => {
    // Chinese-language label `身份证号` (ID-card number) precedes the
    // value with no separator. The ASCII identifier boundary lets the
    // pattern match across the boundary; a Unicode `\w` boundary would
    // have blocked it.
    const text = "身份证号120102196305211080 已登记。";
    const entities = await detect(text);
    const hit = entities.find((e) => e.text.includes("120102196305211080"));
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

  test("19-digit numeric blob does not tag the leading 18-digit substring", async () => {
    // Lookahead must prevent the matcher from consuming 18 of 19
    // digits and reporting an inner span as a national ID.
    const text = "Order number 1201021963052110809 was placed.";
    const entities = await detect(text);
    const spurious = entities.find((e) =>
      e.text.includes("120102196305211080"),
    );
    expect(spurious).toBeUndefined();
  });

  test("17-digit numeric blob is not tagged as a RIC", async () => {
    // The pattern requires exactly the 18-digit modern form.
    const text = "Reference 12010219630521108 in the dossier.";
    const entities = await detect(text);
    const spurious = entities.find((e) => e.text.includes("12010219630521108"));
    expect(spurious).toBeUndefined();
  });

  test("legacy 15-digit form is not tagged as a CN RIC", async () => {
    // The pre-1999 15-digit form shares its bare `\d{15}` shape with
    // fr.nir (also 15 digits). The unified text-search returns one
    // match per offset and picks the earlier-registered pattern, so a
    // 15-digit alternative for cn.ric would shadow legitimate French
    // SSNs. The trade-off is documented in detectors/regex.ts.
    const text = "Legacy ID 110105491001321 was recorded.";
    const entities = await detect(text);
    const hit = entities.find(
      (e) =>
        e.label === "national identification number" &&
        e.text.includes("110105491001321"),
    );
    expect(hit).toBeUndefined();
  });
});
