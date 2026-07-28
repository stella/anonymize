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
  id?: unknown;
  label?: unknown;
  strategy?: { type?: unknown };
  triggers?: unknown;
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
  if (!Array.isArray(value)) {
    throw new TypeError(`triggers.${language}.json must contain an array`);
  }
  return value as TriggerEntry[];
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

const LANGUAGE_ISOLATION_FIXTURES = POSITIVE_FIXTURES.map(
  ([language], index) => {
    const foreign = POSITIVE_FIXTURES[(index + 1) % POSITIVE_FIXTURES.length];
    if (!foreign) {
      throw new TypeError("passport language-isolation fixture is missing");
    }
    return [language, foreign[1]] as const;
  },
);

describe("localized passport-number triggers", () => {
  test("covers every supported content language", async () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const entries = await loadLanguageTriggers(language);
      const entry = entries.find(
        (candidate) => candidate.id === `${language}-passport-number`,
      );

      expect(entry, `${language}-passport-number is missing`).toBeDefined();
      expect(entry?.label).toBe("passport number");
      expect(entry?.strategy?.type).toBe("match-pattern");
      expect(entry?.triggers).toBeArray();
      expect((entry?.triggers as unknown[])?.length).toBeGreaterThan(0);
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

  test.each(LANGUAGE_ISOLATION_FIXTURES)(
    "%s excludes another language's passport triggers",
    async (language, foreignText) => {
      expect(await detect(language, foreignText)).toEqual([]);
    },
  );
});
