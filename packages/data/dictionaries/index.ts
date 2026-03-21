/**
 * Dictionary catalog, loader, and metadata for the
 * deny list system. Dictionaries are loaded lazily
 * via dynamic imports and cached after first load.
 */

type DenyListCategory =
  | "Names"
  | "Places"
  | "Addresses"
  | "Courts"
  | "Financial"
  | "Government"
  | "Healthcare"
  | "Education"
  | "Political"
  | "Organizations"
  | "International";

type DictionaryMeta = {
  label: string;
  category: DenyListCategory;
  country: string | null;
};

export const DICTIONARY_META = {
  // ── Names ──────────────────────────────────────────
  "names/global": {
    label: "person",
    category: "Names",
    country: null,
  },
  "names/cs": {
    label: "person",
    category: "Names",
    country: "CZ",
  },
  "names/de": {
    label: "person",
    category: "Names",
    country: "DE",
  },
  "names/sk": {
    label: "person",
    category: "Names",
    country: "SK",
  },
  "names/pl": {
    label: "person",
    category: "Names",
    country: "PL",
  },

  // ── Countries ──────────────────────────────────────
  // Known FP overlap: France, Italia, Holland, Malta
  // are also personal names. Mitigation at matching
  // layer (span-priority, context disambiguation).
  "countries/translations": {
    label: "country",
    category: "Places",
    country: null,
  },

  // ── Cities ─────────────────────────────────────────
  // City dictionaries are loaded dynamically via
  // loadCityDictionary() — not registered here.
  // See generate-cities.ts for the GeoNames pipeline.
  // 230 countries available in cities/*.json.

  // ── Courts ─────────────────────────────────────────
  "courts/AT": {
    label: "organization",
    category: "Courts",
    country: "AT",
  },
  "courts/AU": {
    label: "organization",
    category: "Courts",
    country: "AU",
  },
  "courts/BE": {
    label: "organization",
    category: "Courts",
    country: "BE",
  },
  "courts/BG": {
    label: "organization",
    category: "Courts",
    country: "BG",
  },
  "courts/BR": {
    label: "organization",
    category: "Courts",
    country: "BR",
  },
  "courts/CA": {
    label: "organization",
    category: "Courts",
    country: "CA",
  },
  "courts/CZ": {
    label: "organization",
    category: "Courts",
    country: "CZ",
  },
  "courts/DE": {
    label: "organization",
    category: "Courts",
    country: "DE",
  },
  "courts/DK": {
    label: "organization",
    category: "Courts",
    country: "DK",
  },
  "courts/ES": {
    label: "organization",
    category: "Courts",
    country: "ES",
  },
  "courts/FI": {
    label: "organization",
    category: "Courts",
    country: "FI",
  },
  "courts/FR": {
    label: "organization",
    category: "Courts",
    country: "FR",
  },
  "courts/GB": {
    label: "organization",
    category: "Courts",
    country: "GB",
  },
  "courts/HR": {
    label: "organization",
    category: "Courts",
    country: "HR",
  },
  "courts/HU": {
    label: "organization",
    category: "Courts",
    country: "HU",
  },
  "courts/IE": {
    label: "organization",
    category: "Courts",
    country: "IE",
  },
  "courts/IT": {
    label: "organization",
    category: "Courts",
    country: "IT",
  },
  "courts/NL": {
    label: "organization",
    category: "Courts",
    country: "NL",
  },
  "courts/NO": {
    label: "organization",
    category: "Courts",
    country: "NO",
  },
  "courts/PL": {
    label: "organization",
    category: "Courts",
    country: "PL",
  },
  "courts/PT": {
    label: "organization",
    category: "Courts",
    country: "PT",
  },
  "courts/RO": {
    label: "organization",
    category: "Courts",
    country: "RO",
  },
  "courts/SE": {
    label: "organization",
    category: "Courts",
    country: "SE",
  },
  "courts/SI": {
    label: "organization",
    category: "Courts",
    country: "SI",
  },
  "courts/SK": {
    label: "organization",
    category: "Courts",
    country: "SK",
  },
  "courts/US": {
    label: "organization",
    category: "Courts",
    country: "US",
  },

  // ── Banks ──────────────────────────────────────────
  "banks/AT": {
    label: "organization",
    category: "Financial",
    country: "AT",
  },
  "banks/AU": {
    label: "organization",
    category: "Financial",
    country: "AU",
  },
  "banks/BE": {
    label: "organization",
    category: "Financial",
    country: "BE",
  },
  "banks/BG": {
    label: "organization",
    category: "Financial",
    country: "BG",
  },
  "banks/BR": {
    label: "organization",
    category: "Financial",
    country: "BR",
  },
  "banks/CA": {
    label: "organization",
    category: "Financial",
    country: "CA",
  },
  "banks/CZ": {
    label: "organization",
    category: "Financial",
    country: "CZ",
  },
  "banks/DE": {
    label: "organization",
    category: "Financial",
    country: "DE",
  },
  "banks/DK": {
    label: "organization",
    category: "Financial",
    country: "DK",
  },
  "banks/ES": {
    label: "organization",
    category: "Financial",
    country: "ES",
  },
  "banks/FI": {
    label: "organization",
    category: "Financial",
    country: "FI",
  },
  "banks/FR": {
    label: "organization",
    category: "Financial",
    country: "FR",
  },
  "banks/GB": {
    label: "organization",
    category: "Financial",
    country: "GB",
  },
  "banks/HR": {
    label: "organization",
    category: "Financial",
    country: "HR",
  },
  "banks/HU": {
    label: "organization",
    category: "Financial",
    country: "HU",
  },
  "banks/IE": {
    label: "organization",
    category: "Financial",
    country: "IE",
  },
  "banks/IT": {
    label: "organization",
    category: "Financial",
    country: "IT",
  },
  "banks/NL": {
    label: "organization",
    category: "Financial",
    country: "NL",
  },
  "banks/NO": {
    label: "organization",
    category: "Financial",
    country: "NO",
  },
  "banks/PL": {
    label: "organization",
    category: "Financial",
    country: "PL",
  },
  "banks/PT": {
    label: "organization",
    category: "Financial",
    country: "PT",
  },
  "banks/RO": {
    label: "organization",
    category: "Financial",
    country: "RO",
  },
  "banks/SE": {
    label: "organization",
    category: "Financial",
    country: "SE",
  },
  "banks/SI": {
    label: "organization",
    category: "Financial",
    country: "SI",
  },
  "banks/SK": {
    label: "organization",
    category: "Financial",
    country: "SK",
  },
  "banks/US": {
    label: "organization",
    category: "Financial",
    country: "US",
  },

  // ── Insurance ──────────────────────────────────────
  "insurance/CZ": {
    label: "organization",
    category: "Financial",
    country: "CZ",
  },
  "insurance/DE": {
    label: "organization",
    category: "Financial",
    country: "DE",
  },

  // ── Education ──────────────────────────────────────
  "education/universities-AT": {
    label: "organization",
    category: "Education",
    country: "AT",
  },
  "education/universities-CZ": {
    label: "organization",
    category: "Education",
    country: "CZ",
  },
  "education/universities-DE": {
    label: "organization",
    category: "Education",
    country: "DE",
  },
  "education/universities-SK": {
    label: "organization",
    category: "Education",
    country: "SK",
  },

  // ── Government ─────────────────────────────────────
  "government/ministries-AT": {
    label: "organization",
    category: "Government",
    country: "AT",
  },
  "government/ministries-CZ": {
    label: "organization",
    category: "Government",
    country: "CZ",
  },
  "government/ministries-DE": {
    label: "organization",
    category: "Government",
    country: "DE",
  },
  "government/ministries-SK": {
    label: "organization",
    category: "Government",
    country: "SK",
  },

  // ── Healthcare ─────────────────────────────────────
  "healthcare/hospitals-CZ": {
    label: "organization",
    category: "Healthcare",
    country: "CZ",
  },
  "healthcare/hospitals-DE": {
    label: "organization",
    category: "Healthcare",
    country: "DE",
  },

  // ── International ──────────────────────────────────
  "international/eu-institutions": {
    label: "organization",
    category: "International",
    country: null,
  },
} as const satisfies Record<string, DictionaryMeta>;

export type DictionaryId = keyof typeof DICTIONARY_META;

type JsonModule = { default: readonly string[] };

// SAFETY: dynamic import() of JSON modules returns
// { default: T } in Bun. The cast is required because
// TS infers a wider type for dynamic imports.
const LOADERS: Record<
  DictionaryId,
  () => Promise<JsonModule>
> = {
  // ── Names ──────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/global": () =>
    import("./names/global.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/cs": () =>
    import("./names/cs.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/de": () =>
    import("./names/de.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/sk": () =>
    import("./names/sk.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "names/pl": () =>
    import("./names/pl.json") as Promise<JsonModule>,

  // ── Countries ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "countries/translations": () =>
    import("./countries/translations.json") as Promise<JsonModule>,

  // ── Cities: loaded dynamically via loadCityDictionary()

  // ── Courts ─────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/AT": () =>
    import("./courts/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/AU": () =>
    import("./courts/AU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BE": () =>
    import("./courts/BE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BG": () =>
    import("./courts/BG.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/BR": () =>
    import("./courts/BR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/CA": () =>
    import("./courts/CA.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/CZ": () =>
    import("./courts/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/DE": () =>
    import("./courts/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/DK": () =>
    import("./courts/DK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/ES": () =>
    import("./courts/ES.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/FI": () =>
    import("./courts/FI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/FR": () =>
    import("./courts/FR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/GB": () =>
    import("./courts/GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/HR": () =>
    import("./courts/HR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/HU": () =>
    import("./courts/HU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/IE": () =>
    import("./courts/IE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/IT": () =>
    import("./courts/IT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/NL": () =>
    import("./courts/NL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/NO": () =>
    import("./courts/NO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/PL": () =>
    import("./courts/PL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/PT": () =>
    import("./courts/PT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/RO": () =>
    import("./courts/RO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SE": () =>
    import("./courts/SE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SI": () =>
    import("./courts/SI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SK": () =>
    import("./courts/SK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/US": () =>
    import("./courts/US.json") as Promise<JsonModule>,

  // ── Banks ──────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/AT": () =>
    import("./banks/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/AU": () =>
    import("./banks/AU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BE": () =>
    import("./banks/BE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BG": () =>
    import("./banks/BG.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/BR": () =>
    import("./banks/BR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/CA": () =>
    import("./banks/CA.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/CZ": () =>
    import("./banks/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/DE": () =>
    import("./banks/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/DK": () =>
    import("./banks/DK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/ES": () =>
    import("./banks/ES.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/FI": () =>
    import("./banks/FI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/FR": () =>
    import("./banks/FR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/GB": () =>
    import("./banks/GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/HR": () =>
    import("./banks/HR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/HU": () =>
    import("./banks/HU.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/IE": () =>
    import("./banks/IE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/IT": () =>
    import("./banks/IT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/NL": () =>
    import("./banks/NL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/NO": () =>
    import("./banks/NO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/PL": () =>
    import("./banks/PL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/PT": () =>
    import("./banks/PT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/RO": () =>
    import("./banks/RO.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SE": () =>
    import("./banks/SE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SI": () =>
    import("./banks/SI.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SK": () =>
    import("./banks/SK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/US": () =>
    import("./banks/US.json") as Promise<JsonModule>,

  // ── Insurance ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "insurance/CZ": () =>
    import("./insurance/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "insurance/DE": () =>
    import("./insurance/DE.json") as Promise<JsonModule>,

  // ── Education ──────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-AT": () =>
    import("./education/universities-AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-CZ": () =>
    import("./education/universities-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-DE": () =>
    import("./education/universities-DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "education/universities-SK": () =>
    import("./education/universities-SK.json") as Promise<JsonModule>,

  // ── Government ─────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-AT": () =>
    import("./government/ministries-AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-CZ": () =>
    import("./government/ministries-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-DE": () =>
    import("./government/ministries-DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "government/ministries-SK": () =>
    import("./government/ministries-SK.json") as Promise<JsonModule>,

  // ── Healthcare ─────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "healthcare/hospitals-CZ": () =>
    import("./healthcare/hospitals-CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "healthcare/hospitals-DE": () =>
    import("./healthcare/hospitals-DE.json") as Promise<JsonModule>,

  // ── International ──────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "international/eu-institutions": () =>
    import("./international/eu-institutions.json") as Promise<JsonModule>,
};

const cache = new Map<DictionaryId, readonly string[]>();

/**
 * Load a single dictionary by ID. Results are cached
 * after the first load.
 */
export const loadDictionary = async (
  id: DictionaryId,
): Promise<readonly string[]> => {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  const loader = LOADERS[id];
  const mod = await loader();
  const entries = mod.default;
  cache.set(id, entries);
  return entries;
};

/**
 * Load multiple dictionaries and merge into a flat
 * array of terms.
 */
export const loadDictionaries = async (
  ...ids: DictionaryId[]
): Promise<readonly string[]> => {
  const results = await Promise.all(
    ids.map(loadDictionary),
  );
  const merged: string[] = [];
  for (const entries of results) {
    for (const entry of entries) {
      merged.push(entry);
    }
  }
  return merged;
};

/**
 * Load multiple dictionaries and return a deduplicated
 * Set of terms.
 */
export const loadDictionarySet = async (
  ...ids: DictionaryId[]
): Promise<ReadonlySet<string>> => {
  const results = await Promise.all(
    ids.map(loadDictionary),
  );
  const set = new Set<string>();
  for (const entries of results) {
    for (const entry of entries) {
      set.add(entry);
    }
  }
  return set;
};

/** Clear the dictionary cache (for tests). */
export const clearDictionaryCache = (): void => {
  cache.clear();
};

/** All dictionary IDs, derived from metadata keys. */
export const ALL_DICTIONARY_IDS: readonly DictionaryId[] =
  Object.keys(DICTIONARY_META).filter(
    (k): k is DictionaryId => k in DICTIONARY_META,
  );

// ── City dictionaries (dynamic loading) ───────────
//
// City dictionaries cover 230 countries from GeoNames
// (CC BY 4.0, pop > 5,000). They are loaded
// dynamically by country code rather than being
// registered in DICTIONARY_META, because the number
// of countries would bloat the static type system.

const cityCache = new Map<string, readonly string[]>();

/**
 * Load city names for a country. Returns an empty
 * array if no dictionary exists for the country.
 *
 * @param countryCode ISO 3166-1 alpha-2 (e.g., "HU")
 */
export const loadCityDictionary = async (
  countryCode: string,
): Promise<readonly string[]> => {
  const cc = countryCode.toUpperCase();
  const cached = cityCache.get(cc);
  if (cached) {
    return cached;
  }

  try {
    // SAFETY: dynamic import of JSON. The country code
    // is validated to be 2 uppercase letters only.
    if (!/^[A-Z]{2}$/.test(cc)) {
      return [];
    }
    const mod = (await import(
      `./cities/${cc}.json`
    )) as JsonModule;
    const entries = mod.default;
    cityCache.set(cc, entries);
    return entries;
  } catch {
    // Dictionary not found for this country
    cityCache.set(cc, []);
    return [];
  }
};

/**
 * Load city dictionaries for multiple countries.
 * Returns merged array of all city names.
 */
export const loadCityDictionaries = async (
  countryCodes: readonly string[],
): Promise<readonly string[]> => {
  const results = await Promise.all(
    countryCodes.map(loadCityDictionary),
  );
  const merged: string[] = [];
  for (const entries of results) {
    for (const entry of entries) {
      merged.push(entry);
    }
  }
  return merged;
};

/** City dictionary metadata (same for all countries). */
export const CITY_DICTIONARY_META: DictionaryMeta = {
  label: "address",
  category: "Places",
  country: null,
};
