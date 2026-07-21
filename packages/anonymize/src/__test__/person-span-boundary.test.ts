/**
 * Person-span boundary regressions: capitalized non-name tokens must not
 * ride along with a real name. Motivated by Czech contract signature grids
 * and PDF digital-signature stamps; the rules are language-agnostic.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { Dictionaries, PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(60_000);

const CONFIG: PipelineConfig = {
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
  countries: ["CZ"],
  nameCorpusLanguages: ["cs"],
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "person-span-boundary-test",
};

let cachedDictionaries: Dictionaries | undefined;
const detect = async (text: string) => {
  cachedDictionaries ??= await loadTestDictionaries();
  return detectNative({ ...CONFIG, dictionaries: cachedDictionaries }, text);
};

const personTexts = async (text: string): Promise<string[]> => {
  const entities = await detect(text);
  return entities.filter((e) => e.label === "person").map((e) => e.text);
};

describe("person span stops before form-field labels", () => {
  test("Czech regression: name does not absorb following Jméno:", async () => {
    const persons = await personTexts(
      "Jméno: Jan Novák Jméno: Mgr. Eva Svobodová",
    );
    expect(persons.some((p) => p.includes("Jméno"))).toBe(false);
    expect(persons.some((p) => p.includes("Jan Novák"))).toBe(true);
  });

  test("English control: Name: label after a name stays out of the span", async () => {
    const persons = await personTexts("Name: Jane Roe Name: John Smith");
    expect(persons.some((p) => /\bName\b/.test(p))).toBe(false);
    expect(persons.some((p) => p.includes("Jane Roe"))).toBe(true);
  });
});

describe("titled person does not absorb digital-signature modifiers", () => {
  test("Czech regression: Digitálně after a titled given name", async () => {
    const persons = await personTexts("Mgr. Karel Digitálně podepsal");
    expect(persons.some((p) => p.includes("Digitálně"))).toBe(false);
    expect(persons.some((p) => p.includes("Karel"))).toBe(true);
  });

  test("English control: Digitally signed does not become a surname", async () => {
    const persons = await personTexts("Dr. Jane Digitally signed");
    expect(persons.some((p) => p.includes("Digitally"))).toBe(false);
    expect(persons.some((p) => p.includes("Jane"))).toBe(true);
  });

  test("unknown surname without following prose stays in the span", async () => {
    const persons = await personTexts("Mgr. Karel Quigley");
    expect(persons.some((p) => p.includes("Quigley"))).toBe(true);
  });
});
