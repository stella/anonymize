/**
 * Test helper: loads dictionaries from @stll/anonymize-data
 * and returns a Dictionaries object suitable for injection
 * into PipelineConfig.
 *
 * Only used in tests — production consumers load and pass
 * dictionaries themselves.
 */
import type { Dictionaries, DictionaryMeta } from "../types";

let cached: Dictionaries | null = null;

export const loadTestDictionaries = async (): Promise<Dictionaries> => {
  if (cached) return cached;

  const dataModule = await import("@stll/anonymize-data");

  // Load all dictionaries
  const allIds = [...dataModule.ALL_DICTIONARY_IDS];
  const denyList: Record<string, readonly string[]> = {};
  const denyListMeta: Record<string, DictionaryMeta> = {};

  const results = await Promise.all(
    allIds.map(async (id) => {
      const entries = await dataModule.loadDictionary(id);
      return { id, entries };
    }),
  );

  for (const { id, entries } of results) {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) continue;
    denyList[id] = entries;
    // SAFETY: anonymize-data categories match DenyListCategory at runtime
    denyListMeta[id] = meta as DictionaryMeta;
  }

  // Load per-language first names and surnames
  const NAME_LANGUAGES = [
    "cs",
    "sk",
    "de",
    "pl",
    "hu",
    "ro",
    "fr",
    "es",
    "it",
    "en",
    "sv",
  ] as const;

  const firstNames: Record<string, readonly string[]> = {};
  const surnames: Record<string, readonly string[]> = {};

  await Promise.all(
    NAME_LANGUAGES.map(async (lang) => {
      try {
        const mod = await import(
          `@stll/anonymize-data/dictionaries/names/first/${lang}.json`
        );
        firstNames[lang] = mod.default;
      } catch {
        // Not available for this language
      }
      try {
        const mod = await import(
          `@stll/anonymize-data/dictionaries/names/surnames/${lang}.json`
        );
        surnames[lang] = mod.default;
      } catch {
        // Not available for this language
      }
    }),
  );

  // Load city dictionaries for common countries
  const CITY_COUNTRIES = [
    "AT",
    "AU",
    "BE",
    "BG",
    "BR",
    "CA",
    "CH",
    "CZ",
    "DE",
    "DK",
    "ES",
    "FI",
    "FR",
    "GB",
    "GR",
    "HR",
    "HU",
    "IE",
    "IT",
    "LU",
    "NL",
    "NO",
    "NZ",
    "PL",
    "PT",
    "RO",
    "SE",
    "SI",
    "SK",
    "US",
  ];
  const cities = await dataModule.loadCityDictionaries(CITY_COUNTRIES);

  const result: Dictionaries = {
    firstNames,
    surnames,
    denyList,
    denyListMeta,
    cities,
  };

  cached = result;
  return result;
};
