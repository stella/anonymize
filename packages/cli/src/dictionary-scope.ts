/* Pure helpers shared by the npm and embedded dictionary
 * loaders. Must stay free of @stll/anonymize-data imports
 * so the compiled binary's bundle excludes the raw JSON
 * dictionary modules. */
import type { Dictionaries, DictionaryMeta } from "@stll/anonymize";

import { UsageError } from "./args";

export const NAME_DICTIONARY_PREFIXES = [
  "names/first/",
  "names/surnames/",
] as const;

/** Language code of a name dictionary id, or null. */
export const nameLanguageOfDictionary = (id: string): string | null => {
  const prefix = NAME_DICTIONARY_PREFIXES.find((p) => id.startsWith(p));
  return prefix ? id.slice(prefix.length) : null;
};

export type DictionaryScope = {
  languages?: readonly string[] | undefined;
  countries?: readonly string[] | undefined;
};

const pickKeys = <T>(
  record: Record<string, T>,
  keep: (key: string) => boolean,
): Record<string, T> => {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keep(key)) result[key] = value;
  }
  return result;
};

/** Dictionaries with every section present (possibly empty). */
export type ScopedDictionaries = Dictionaries & {
  firstNames: Record<string, readonly string[]>;
  surnames: Record<string, readonly string[]>;
  denyList: Record<string, readonly string[]>;
  denyListMeta: Record<string, DictionaryMeta>;
  citiesByCountry: Record<string, readonly string[]>;
};

/**
 * Scope a fully loaded dictionary set to the requested
 * languages and countries. Mirrors the pre-load scoping
 * the npm loader does in dictionaries.ts; used by the
 * embedded loader, which always starts from the full set.
 */
export const filterDictionaries = (
  all: Dictionaries,
  { languages, countries }: DictionaryScope,
): ScopedDictionaries => {
  const firstNames = all.firstNames ?? {};
  const surnames = all.surnames ?? {};
  const allDenyList = all.denyList ?? {};
  const allDenyListMeta = all.denyListMeta ?? {};

  if (languages !== undefined) {
    const available = Object.keys(firstNames);
    const invalid = languages.find((lang) => !available.includes(lang));
    if (invalid) {
      throw new UsageError(
        `--languages: no name dictionary for "${invalid}"; available: ${available.join(", ")}`,
      );
    }
  }
  const keepLanguage = (lang: string): boolean =>
    languages === undefined || languages.includes(lang);
  const keepCountry = (country: string | null): boolean =>
    countries === undefined || country === null || countries.includes(country);

  const denyListMeta: Record<string, DictionaryMeta> = {};
  const denyList: Record<string, readonly string[]> = {};
  for (const [id, meta] of Object.entries(allDenyListMeta)) {
    if (!keepCountry(meta.country)) continue;
    const nameLang = nameLanguageOfDictionary(id);
    if (nameLang !== null && !keepLanguage(nameLang)) continue;
    const entries = allDenyList[id];
    if (entries === undefined) continue;
    denyListMeta[id] = meta;
    denyList[id] = entries;
  }

  return {
    firstNames: pickKeys(firstNames, keepLanguage),
    surnames: pickKeys(surnames, keepLanguage),
    denyList,
    denyListMeta,
    citiesByCountry: pickKeys(all.citiesByCountry ?? {}, (country) =>
      keepCountry(country),
    ),
  };
};
