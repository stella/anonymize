/**
 * Loads the full published dictionary set from @stll/anonymize-data
 * the way a production consumer would. Mirrors the corpus used by
 * the anonymize regression suite (see
 * packages/anonymize/src/__test__/load-dictionaries.ts) so bench
 * results stay comparable with the committed snapshots; keep the
 * language and country lists in sync.
 */
import type { Dictionaries, DictionaryMeta } from "@stll/anonymize";

let cached: Dictionaries | null = null;

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
] as const;

type NameDictionaryModule = {
  default: readonly string[];
};

const loadNameDictionary = async (
  kind: "first" | "surnames",
  language: string,
): Promise<readonly string[] | null> => {
  try {
    const mod: NameDictionaryModule = await import(
      `@stll/anonymize-data/dictionaries/names/${kind}/${language}.json`
    );
    return mod.default;
  } catch {
    return null;
  }
};

export const loadBenchDictionaries = async (): Promise<Dictionaries> => {
  if (cached) return cached;

  const dataModule = await import("@stll/anonymize-data");

  const denyList: Record<string, readonly string[]> = {};
  const denyListMeta: Record<string, DictionaryMeta> = {};
  const denyListResults = await Promise.all(
    [...dataModule.ALL_DICTIONARY_IDS].map(async (id) => ({
      id,
      entries: await dataModule.loadDictionary(id),
    })),
  );
  for (const { id, entries } of denyListResults) {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) continue;
    denyList[id] = entries;
    // SAFETY: anonymize-data categories match DenyListCategory at runtime
    denyListMeta[id] = meta as DictionaryMeta;
  }

  const firstNames: Record<string, readonly string[]> = {};
  const surnames: Record<string, readonly string[]> = {};
  await Promise.all(
    NAME_LANGUAGES.map(async (language) => {
      const [first, last] = await Promise.all([
        loadNameDictionary("first", language),
        loadNameDictionary("surnames", language),
      ]);
      if (first) firstNames[language] = first;
      if (last) surnames[language] = last;
    }),
  );

  const cityResults = await Promise.all(
    CITY_COUNTRIES.map(async (country) => ({
      country,
      entries: await dataModule.loadCityDictionary(country),
    })),
  );
  const citiesByCountry: Record<string, readonly string[]> = {};
  const mergedCities: string[] = [];
  for (const { country, entries } of cityResults) {
    citiesByCountry[country] = entries;
    for (const entry of entries) {
      mergedCities.push(entry);
    }
  }

  cached = {
    firstNames,
    surnames,
    denyList,
    denyListMeta,
    cities: mergedCities,
    citiesByCountry,
  };
  return cached;
};
