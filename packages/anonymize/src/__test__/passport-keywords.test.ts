import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const SUPPORTED_LANGUAGES = [
  "cs",
  "de",
  "en",
  "es",
  "fr",
  "hu",
  "it",
  "pl",
  "pt-br",
  "ro",
  "sk",
  "sv",
] as const;

type TriggerEntry = {
  id?: string;
  label: string;
  strategy: { type: string };
  triggers: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTriggerEntry = (value: unknown): value is TriggerEntry => {
  if (!isRecord(value) || !isRecord(value.strategy)) {
    return false;
  }
  return (
    (value.id === undefined || typeof value.id === "string") &&
    typeof value.label === "string" &&
    typeof value.strategy.type === "string" &&
    Array.isArray(value.triggers) &&
    value.triggers.every((trigger) => typeof trigger === "string")
  );
};

const loadLanguageTriggers = async (
  language: (typeof SUPPORTED_LANGUAGES)[number],
): Promise<TriggerEntry[]> => {
  const value: unknown = await Bun.file(
    new URL(
      `../../../../packages/data/config/triggers.${language}.json`,
      import.meta.url,
    ),
  ).json();
  if (!Array.isArray(value) || !value.every(isTriggerEntry)) {
    throw new TypeError(
      `triggers.${language}.json must contain valid trigger entries`,
    );
  }
  return value;
};

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["passport number"],
  workspaceId: "passport-keywords-test",
};

const detect = (
  language: string,
  fullText: string,
): Promise<NativePipelineEntity[]> =>
  detectNative({ ...BASE_CONFIG, languages: [language] }, fullText);

const POSITIVE_FIXTURES = [
  ["cs", "cestovní pas č. AB123456", "AB123456"],
  ["de", "Reisepass Nr. C01X00T47", "C01X00T47"],
  ["en", "passport number A1234567", "A1234567"],
  ["es", "número de pasaporte PAA123456", "PAA123456"],
  ["fr", "passeport n° AB1234567", "AB1234567"],
  ["hu", "útlevélszám AB1234567", "AB1234567"],
  ["it", "numero di passaporto AB1234567", "AB1234567"],
  ["pl", "numer paszportu AB1234567", "AB1234567"],
  ["pt-br", "número do passaporte AB123456", "AB123456"],
  ["ro", "numărul pașaportului AB123456", "AB123456"],
  ["sk", "číslo pasu AB1234567", "AB1234567"],
  ["sv", "passnummer 12345678", "12345678"],
] as const;

const NEGATIVE_FIXTURES = [
  ["cs", "cestovní pas ABC12345"],
  ["de", "Reisepass ABC12345"],
  ["en", "passport number ABC12345"],
  ["es", "número de pasaporte ABC12345"],
  ["fr", "passeport ABC12345"],
  ["hu", "útlevélszám ABC12345"],
  ["it", "numero di passaporto ABC12345"],
  ["pl", "numer paszportu ABC12345"],
  ["pt-br", "número do passaporte ABC12345"],
  ["ro", "numărul pașaportului ABC12345"],
  ["sk", "číslo pasu ABC12345"],
  ["sv", "passnummer ABC12345"],
] as const;

const ALL_LETTER_FIXTURES = POSITIVE_FIXTURES.map(
  ([language, text, passportNumber]) =>
    [language, text.replace(passportNumber, "requested")] as const,
);

const PUNCTUATED_CONTINUATION_FIXTURES = POSITIVE_FIXTURES.map(
  ([language, text, passportNumber]) =>
    [language, text.replace(passportNumber, `${passportNumber}-OLD`)] as const,
);

const SEPARATOR_CONTINUATION_FIXTURES = POSITIVE_FIXTURES.flatMap(
  ([language, text, passportNumber]) => [
    [language, text.replace(passportNumber, `${passportNumber} / 99`)] as const,
    [language, text.replace(passportNumber, `${passportNumber}--99`)] as const,
    [
      language,
      text.replace(passportNumber, `${passportNumber} - - 99`),
    ] as const,
    [language, text.replace(passportNumber, `${passportNumber}..99`)] as const,
  ],
);

const SENTENCE_PUNCTUATION_FIXTURES = POSITIVE_FIXTURES.map(
  ([language, text, passportNumber]) =>
    [
      language,
      text.replace(passportNumber, `${passportNumber}. The holder`),
      passportNumber,
    ] as const,
);

const QUOTE_WRAPPERS = [
  ['"', '"'],
  ["„", "“"],
  ["“", "”"],
  ["«", "»"],
  ["‹", "›"],
  ["(", ")"],
] as const;

const QUOTED_FIXTURES = POSITIVE_FIXTURES.map(
  ([language, text, passportNumber], index) => {
    const wrapper = QUOTE_WRAPPERS[index % QUOTE_WRAPPERS.length];
    if (!wrapper) {
      throw new TypeError("passport quote fixture is missing");
    }
    const [open, close] = wrapper;
    return [
      language,
      `😀 ${text.replace(passportNumber, `${open}${passportNumber}${close}`)}`,
      passportNumber,
    ] as const;
  },
);

const CANONICALLY_DECOMPOSED_FIXTURES = POSITIVE_FIXTURES.flatMap(
  ([language, text, passportNumber]) => {
    const decomposed = text.normalize("NFD");
    return decomposed === text
      ? []
      : [[language, `😀 ${decomposed}`, passportNumber] as const];
  },
);

const PUNCTUATED_ABBREVIATION_FIXTURES = [
  ["pl", "paszport nr. AB1234567", "AB1234567"],
  ["sv", "pass nr. 12345678", "12345678"],
] as const;

const LANGUAGE_ISOLATION_FIXTURES = POSITIVE_FIXTURES.flatMap(([language]) =>
  POSITIVE_FIXTURES.flatMap(([foreignLanguage, foreignText]) =>
    language === foreignLanguage ? [] : [[language, foreignText] as const],
  ),
);

describe("localized passport-number triggers", () => {
  test("covers every supported content language", async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const entries = await loadLanguageTriggers(language);
      const entry = entries.find(
        (candidate) => candidate.id === `${language}-passport-number`,
      );

      if (!entry) {
        throw new TypeError(`${language}-passport-number is missing`);
      }
      expect(entry.label).toBe("passport number");
      expect(entry.strategy.type).toBe("match-pattern");
      expect(entry.triggers.length).toBeGreaterThan(0);
    }
  });

  test.each(POSITIVE_FIXTURES)(
    "%s detects the localized passport value",
    async (language, text, expected) => {
      const entities = await detect(language, text);

      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "passport number",
            text: expected,
          }),
        ]),
      );
    },
  );

  test.each(NEGATIVE_FIXTURES)(
    "%s rejects an invalid passport shape",
    async (language, text) => {
      const entities = await detect(language, text);

      expect(entities).toEqual([]);
    },
  );

  test.each(ALL_LETTER_FIXTURES)(
    "%s rejects an all-letter value",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );

  test.each(PUNCTUATED_CONTINUATION_FIXTURES)(
    "%s rejects a punctuated continuation",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );

  test.each(SEPARATOR_CONTINUATION_FIXTURES)(
    "%s rejects a spaced or repeated separator continuation",
    async (language, text) => {
      expect(await detect(language, text)).toEqual([]);
    },
  );

  test.each(SENTENCE_PUNCTUATION_FIXTURES)(
    "%s keeps ordinary sentence punctuation outside the passport",
    async (language, text, expected) => {
      const entities = await detect(language, text);
      const passport = entities.find(
        (entity) => entity.label === "passport number",
      );

      expect(passport?.text).toBe(expected);
      expect(passport && text.slice(passport.start, passport.end)).toBe(
        expected,
      );
    },
  );

  test.each(QUOTED_FIXTURES)(
    "%s detects a passport value after an opening delimiter",
    async (language, text, expected) => {
      const entities = await detect(language, text);
      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "passport number",
            text: expected,
          }),
        ]),
      );
      const passport = entities.find(
        (entity) => entity.label === "passport number",
      );
      expect(passport && text.slice(passport.start, passport.end)).toBe(
        expected,
      );
    },
  );

  test.each(CANONICALLY_DECOMPOSED_FIXTURES)(
    "%s detects canonically decomposed passport triggers",
    async (language, text, expected) => {
      const entities = await detect(language, text);
      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "passport number",
            text: expected,
          }),
        ]),
      );
      const passport = entities.find(
        (entity) => entity.label === "passport number",
      );
      expect(passport && text.slice(passport.start, passport.end)).toBe(
        expected,
      );
    },
  );

  test.each(PUNCTUATED_ABBREVIATION_FIXTURES)(
    "%s detects a punctuated passport abbreviation",
    async (language, text, expected) => {
      expect(await detect(language, text)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "passport number",
            text: expected,
          }),
        ]),
      );
    },
  );

  test.each(LANGUAGE_ISOLATION_FIXTURES)(
    "%s excludes another language's passport triggers",
    async (language, foreignText) => {
      expect(await detect(language, foreignText)).toEqual([]);
    },
  );
});
