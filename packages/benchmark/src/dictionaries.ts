import type { Dictionaries, DictionaryMeta } from "@stll/anonymize";
import {
  ALL_DICTIONARY_IDS,
  DICTIONARY_META,
  loadDictionary,
  loadNameDictionaries,
  NAME_LANGUAGES,
} from "@stll/anonymize-data";

const dictionaryCache = new Map<string, Promise<Dictionaries>>();

const normalizeLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("benchmark dictionary language must not be empty");
  }
  return normalized;
};

const nameLanguagesFor = (
  language: string,
): (typeof NAME_LANGUAGES)[number][] => {
  const exact = NAME_LANGUAGES.find((candidate) => candidate === language);
  if (exact !== undefined) {
    return [exact];
  }
  const base = language.split("-").at(0);
  const fallback = NAME_LANGUAGES.find((candidate) => candidate === base);
  return fallback === undefined ? [] : [fallback];
};

/**
 * Legal benchmark documents declare a content language but not a jurisdiction.
 * Load only that language's names plus country-neutral dictionaries; guessing a
 * country from the language would mix unrelated national legal vocabularies.
 * Cities are likewise omitted until a corpus supplies explicit jurisdiction.
 */
const loadScopedCorpusDictionaries = async (
  language: string,
): Promise<Dictionaries> => {
  const neutralIds = ALL_DICTIONARY_IDS.filter((id) => {
    const meta = DICTIONARY_META[id];
    return meta.country === null && meta.category !== "Names";
  });
  const [names, denyEntries] = await Promise.all([
    loadNameDictionaries(nameLanguagesFor(language)),
    Promise.all(
      neutralIds.map(async (id) => ({
        id,
        entries: await loadDictionary(id),
      })),
    ),
  ]);

  const denyList: Record<string, readonly string[]> = {};
  const denyListMeta: Record<string, DictionaryMeta> = {};
  for (const { id, entries } of denyEntries) {
    denyList[id] = entries;
    denyListMeta[id] = DICTIONARY_META[id];
  }

  return {
    firstNames: names.firstNames,
    surnames: names.surnames,
    denyList,
    denyListMeta,
    citiesByCountry: {},
  };
};

/** Load and cache one language-scoped benchmark dictionary bundle. */
export const loadCorpusDictionaries = (
  language: string,
): Promise<Dictionaries> => {
  const normalized = normalizeLanguage(language);
  const cached = dictionaryCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadScopedCorpusDictionaries(normalized);
  dictionaryCache.set(normalized, pending);
  return pending;
};
