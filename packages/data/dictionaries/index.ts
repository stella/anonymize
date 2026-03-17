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

  // ── Cities ─────────────────────────────────────────
  "cities/AT": {
    label: "address",
    category: "Places",
    country: "AT",
  },
  "cities/BE": {
    label: "address",
    category: "Places",
    country: "BE",
  },
  "cities/CZ": {
    label: "address",
    category: "Places",
    country: "CZ",
  },
  "cities/DE": {
    label: "address",
    category: "Places",
    country: "DE",
  },
  "cities/ES": {
    label: "address",
    category: "Places",
    country: "ES",
  },
  "cities/FR": {
    label: "address",
    category: "Places",
    country: "FR",
  },
  "cities/GB": {
    label: "address",
    category: "Places",
    country: "GB",
  },
  "cities/IE": {
    label: "address",
    category: "Places",
    country: "IE",
  },
  "cities/IT": {
    label: "address",
    category: "Places",
    country: "IT",
  },
  "cities/NL": {
    label: "address",
    category: "Places",
    country: "NL",
  },
  "cities/PL": {
    label: "address",
    category: "Places",
    country: "PL",
  },
  "cities/SK": {
    label: "address",
    category: "Places",
    country: "SK",
  },
  "cities/US": {
    label: "address",
    category: "Places",
    country: "US",
  },

  // ── Courts ─────────────────────────────────────────
  "courts/AT": {
    label: "organization",
    category: "Courts",
    country: "AT",
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
  "courts/SK": {
    label: "organization",
    category: "Courts",
    country: "SK",
  },

  // ── Banks ──────────────────────────────────────────
  "banks/AT": {
    label: "organization",
    category: "Financial",
    country: "AT",
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
  "banks/SK": {
    label: "organization",
    category: "Financial",
    country: "SK",
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

  // ── Cities ─────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/AT": () =>
    import("./cities/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/BE": () =>
    import("./cities/BE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/CZ": () =>
    import("./cities/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/DE": () =>
    import("./cities/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/ES": () =>
    import("./cities/ES.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/FR": () =>
    import("./cities/FR.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/GB": () =>
    import("./cities/GB.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/IE": () =>
    import("./cities/IE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/IT": () =>
    import("./cities/IT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/NL": () =>
    import("./cities/NL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/PL": () =>
    import("./cities/PL.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/SK": () =>
    import("./cities/SK.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "cities/US": () =>
    import("./cities/US.json") as Promise<JsonModule>,

  // ── Courts ─────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/AT": () =>
    import("./courts/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/CZ": () =>
    import("./courts/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/DE": () =>
    import("./courts/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "courts/SK": () =>
    import("./courts/SK.json") as Promise<JsonModule>,

  // ── Banks ──────────────────────────────────────────
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/AT": () =>
    import("./banks/AT.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/CZ": () =>
    import("./banks/CZ.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/DE": () =>
    import("./banks/DE.json") as Promise<JsonModule>,
  // eslint-disable-next-line typescript-eslint/promise-function-async
  "banks/SK": () =>
    import("./banks/SK.json") as Promise<JsonModule>,

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
