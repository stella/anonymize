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
  denyListCountries: ["CZ"],
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

const personTextsForLanguages = async (
  text: string,
  languages: string[],
): Promise<string[]> => {
  cachedDictionaries ??= await loadTestDictionaries();
  const entities = await detectNative(
    {
      ...CONFIG,
      dictionaries: cachedDictionaries,
      languages,
      nameCorpusLanguages: languages,
    },
    text,
  );
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

  test("resolved person span stops before a multi-word acronym label", async () => {
    const persons = await personTexts("Jane Roe VAT ID: 123");
    expect(persons).toContain("Jane Roe");
    expect(persons.some((person) => person.includes("VAT"))).toBe(false);
  });

  test("resolved person span stops before an English tax acronym", async () => {
    const persons = await personTextsForLanguages("Jane Roe EIN: 12-3456789", [
      "en",
    ]);
    expect(persons).toContain("Jane Roe");
    expect(persons.some((person) => person.includes("EIN"))).toBe(false);
  });

  test("all-caps surname before a colon stays redacted", async () => {
    const persons = await personTexts("Pan JANE DOE: authorized signer");
    expect(persons).toContain("JANE DOE");
  });
});

describe("trailing role trigger does not emit field-label values as people", () => {
  test("Czech regression: IČO after ředitelem is not a person", async () => {
    const persons = await personTextsForLanguages(
      [
        "zastoupená prof. MUDr. Markem Svobodou, Ph.D., ředitelem",
        "IČO: 00209805, DIČ: CZ00209805",
      ].join("\n"),
      ["cs"],
    );
    expect(persons.some((p) => /^IČO:?$/u.test(p.trim()))).toBe(false);
    expect(persons.some((p) => p.includes("Markem Svobodou"))).toBe(true);
  });

  test("Czech acronym label permits whitespace before its colon", async () => {
    const persons = await personTextsForLanguages(
      [
        "zastoupená prof. MUDr. Markem Svobodou, Ph.D., ředitelem",
        "IČO : 00209805, DIČ : CZ00209805",
      ].join("\n"),
      ["cs"],
    );
    expect(persons.some((p) => /^IČO:?$/u.test(p.trim()))).toBe(false);
    expect(persons.some((p) => p.includes("Markem Svobodou"))).toBe(true);
  });

  test("Slovak IČO after a role is not a person", async () => {
    const persons = await personTextsForLanguages(
      "zastúpená Janou Novákovou, konateľkou\nIČO: 00209805, DIČ: SK00209805",
      ["sk"],
    );
    expect(persons.some((p) => /^IČO:?$/u.test(p.trim()))).toBe(false);
    expect(persons.some((p) => p.includes("Janou Novákovou"))).toBe(true);
  });

  test("English identity field after a role is not a person", async () => {
    const persons = await personTextsForLanguages(
      "signed by Jane Roe, director\nSocial Security Number: 12-3456789, USA",
      ["en"],
    );
    expect(persons).not.toContain("Social Security Number");
    expect(persons.some((p) => p.includes("Jane Roe"))).toBe(true);
  });

  test("role prefix still extracts the following person", async () => {
    // Uses jednatelem (vocabulary role), not a string hardcoded in detector code.
    const persons = await personTexts(
      "Smlouva podepsaná jednatelem Janem Novákem dne 1. 1. 2026",
    );
    expect(persons.some((p) => p.includes("Janem Novákem"))).toBe(true);
  });

  test("organization trigger control stays organization", async () => {
    const entities = await detect(
      "zhotovitel: Gymnázium Jana Keplera, IČO: 12345678",
    );
    const orgs = entities
      .filter((e) => e.label === "organization")
      .map((e) => e.text);
    expect(orgs.some((o) => o.includes("Gymnázium"))).toBe(true);
    expect(
      entities.some((e) => e.label === "person" && /^IČO:?$/u.test(e.text)),
    ).toBe(false);
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

describe("unknown surnames survive in running prose", () => {
  /**
   * Under-redaction guard. A shape heuristic ("a capitalized token before
   * lowercase prose is a modifier, not a surname") drops every one of these,
   * because -ly / -ně / -lich / -ment(e) are ordinary surname endings. Only
   * exact stamp/label vocabulary may end a person span.
   */
  const cases = [
    "Mgr. Karel Quigley podepsal smlouvu",
    "Mgr. Karel Ehrlich podepsal smlouvu",
    "Mgr. Karel Clemente souhlasí s podmínkami",
    "Mgr. Karel Connolly je zástupce společnosti",
  ];

  for (const text of cases) {
    const surname = text.split(" ")[2] ?? "";
    test(`${surname} is not trimmed before lowercase prose`, async () => {
      const persons = await personTexts(text);
      expect(persons.some((p) => p.includes(surname))).toBe(true);
    });
  }
});
