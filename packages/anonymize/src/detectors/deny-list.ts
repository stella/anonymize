import type { Match } from "@stll/text-search";

import {
  expandNameDeclensions,
  getNameCorpusFirstNames,
  initNameCorpus,
  nameCorpusCacheKey,
} from "./names";
import { resolveCountries } from "../regions";
import { DETECTION_SOURCES } from "../types";
import type {
  Dictionaries,
  DictionaryMeta,
  Entity,
  PipelineConfig,
} from "../types";
import type { KeyedLoad, NameCorpusData, PipelineContext } from "../context";
import { defaultContext } from "../context";
import { loadGenericRoles } from "../filters/false-positives";
import { buildStreetTypePatterns } from "./address-seeds";
import {
  getClauseNounHeadsSync,
  getLegalRoleHeadsSync,
  warmLegalRoleHeads,
} from "./legal-forms";
import { normalizeForSearch } from "../util/normalize";
import { ALL_UPPER_RE, UPPER_START_RE } from "../util/text";
import { DASH } from "../util/char-groups";
import denyListFiltersByLanguage from "../data/deny-list-filters.json";

export type DenyListConfig = Pick<
  PipelineConfig,
  | "enableDenyList"
  | "enableNameCorpus"
  | "nameCorpusLanguages"
  | "denyListCountries"
  | "denyListRegions"
  | "denyListExcludeCategories"
  | "customDenyList"
  | "dictionaries"
  | "enableCountries"
>;

const lowerSortedUnique = (values: Iterable<string>): string[] =>
  [...new Set([...values].map((value) => value.toLowerCase()))].toSorted();

const collectLanguageWordValues = (data: Record<string, unknown>): string[] => {
  const words: string[] = [];
  const append = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const word of value) {
      if (typeof word === "string" && word.length > 0) {
        words.push(word);
      }
    }
  };

  append(data["words"]);
  for (const [key, value] of Object.entries(data)) {
    if (key === "words" || key.startsWith("_")) {
      continue;
    }
    append(value);
  }

  return lowerSortedUnique(words);
};

// ── Allow list (lazy-loaded from JSON) ───────────────

const loadAllowList = (ctx: PipelineContext): Promise<ReadonlySet<string>> => {
  if (ctx.allowListPromise) return ctx.allowListPromise;
  ctx.allowListPromise = (async () => {
    try {
      const mod: {
        default?: { words?: string[] };
      } = await import("../data/allow-list.json");
      const set: ReadonlySet<string> = new Set(mod.default?.words ?? []);
      ctx.allowList = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      ctx.allowList = empty;
      return empty;
    }
  })();
  return ctx.allowListPromise;
};

const EMPTY_ALLOW_LIST: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
const getAllowList = (ctx: PipelineContext): ReadonlySet<string> =>
  ctx.allowList ?? EMPTY_ALLOW_LIST;

let commonWordsPromise: Promise<ReadonlySet<string>> | null = null;
let commonWordsCache: ReadonlySet<string> | null = null;

const EMPTY_COMMON_WORDS: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
const getCommonWords = (): ReadonlySet<string> =>
  commonWordsCache ?? EMPTY_COMMON_WORDS;

const loadCommonWords = (): Promise<ReadonlySet<string>> => {
  if (commonWordsCache) return Promise.resolve(commonWordsCache);
  if (commonWordsPromise) return commonWordsPromise;
  commonWordsPromise = (async () => {
    try {
      const mod: { default?: { words?: string[] } } =
        await import("../data/common-words-en.json");
      const set: ReadonlySet<string> = new Set(
        (mod.default?.words ?? []).map((word) => word.toLowerCase()),
      );
      commonWordsCache = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      commonWordsCache = empty;
      return empty;
    }
  })();
  return commonWordsPromise;
};

let monthNamesPromise: Promise<ReadonlySet<string>> | null = null;
let monthNamesCache: ReadonlySet<string> | null = null;

/**
 * English month names, lowercased. City gazetteers carry a
 * handful of entries that collide with month words (e.g. a
 * place named "August"); in prose these surface as address
 * false positives where the token is plainly a date, so they
 * are dropped from address patterns at build time.
 */
const loadMonthNames = (): Promise<ReadonlySet<string>> => {
  if (monthNamesCache) return Promise.resolve(monthNamesCache);
  if (monthNamesPromise) return monthNamesPromise;
  monthNamesPromise = (async () => {
    try {
      const mod: { default?: { en?: string[] } } =
        await import("../data/date-months.json");
      const set: ReadonlySet<string> = new Set(
        (mod.default?.en ?? []).map((month) => month.toLowerCase()),
      );
      monthNamesCache = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      monthNamesCache = empty;
      return empty;
    }
  })();
  return monthNamesPromise;
};

/**
 * Curated dictionary entries that are pure dotted
 * single-letter acronyms (e.g. `S.C.`, `D.N.J.`, `C.E.C.`)
 * need targeted suffix guards. The AC search matches
 * case-insensitively on token boundaries where `.` is not
 * a word character, so `S.C.` can match inside `U.S.C.`.
 * Two-segment non-address aliases are too noisy and are
 * dropped at build time; longer official aliases stay
 * searchable and are only suppressed when the source text
 * shows they are the tail of a longer dotted token.
 * Caller-supplied custom entries are exempted.
 */
const DOTTED_ACRONYM_RE = /^(?=.{3,}$)\p{L}(?:\.\p{L}){0,3}\.?$/u;

const isCuratedNoiseAcronym = (normalized: string): boolean =>
  DOTTED_ACRONYM_RE.test(normalized);

const dottedAcronymSegmentCount = (normalized: string): number =>
  normalized.split(".").filter(Boolean).length;

const isShortCuratedNoiseAcronym = (normalized: string): boolean =>
  isCuratedNoiseAcronym(normalized) &&
  dottedAcronymSegmentCount(normalized) <= 2;

const isDottedAcronymSuffixCollision = (
  fullText: string,
  start: number,
  matchText: string,
): boolean =>
  isCuratedNoiseAcronym(matchText) &&
  /[\p{L}]\.$/u.test(fullText.slice(Math.max(0, start - 2), start));

/**
 * Common EU given names present in the stopwords-iso dataset
 * but absent from the first-name corpus. Without this
 * supplementary set, these names would pass through the
 * corpus-based filter and remain in the stopwords, silently
 * suppressing person detection.
 *
 * Sourced from EU member state birth registries (top-100
 * names) cross-referenced with stopwords.json.
 */
const SUPPLEMENTARY_NAME_EXCLUSIONS: ReadonlySet<string> = new Set([
  "ana",
  "ben",
  "dan",
  "eden",
  "ella",
  "ina",
  "jo",
  "kai",
  "lena",
  "may",
  "mia",
  "sam",
  "sara",
  "sue",
  "tim",
  "tom",
]);

/**
 * Names from the first-name corpus (lowercased) that also
 * appear in the stopwords-iso dataset, plus supplementary
 * common EU given names not in the corpus. These must be
 * kept out of global STOPWORDS so that person detection is
 * not silently suppressed for real given names.
 *
 * Pure function of the corpus: the stopword loader that calls it is keyed by
 * the corpus identity, so the exclusion set is rebuilt whenever the corpus
 * changes (never aliased across corpora that merely share a first-name count).
 */
const buildFirstNameExclusions = (
  corpus: NameCorpusData | null,
): ReadonlySet<string> =>
  new Set([
    ...(corpus?.firstNamesList ?? []).map((n) => n.toLowerCase()),
    ...SUPPLEMENTARY_NAME_EXCLUSIONS,
  ]);

/**
 * Global stopwords: common words across 23 EU languages
 * sourced from the stopwords-iso dataset (MIT license).
 * Checked case-insensitively against matches.
 *
 * Entries that collide with the first-name corpus are
 * excluded so they can still be detected as person names.
 *
 * Regenerate: bun packages/data/scripts/generate-stopwords.ts
 */

// INVARIANT: the caller passes the corpus already resolved by initNameCorpus,
// so the first-name exclusions reflect the full corpus. `corpusKey` is the
// corpus identity (dictionary identity + selected languages), NOT a first-name
// count: two distinct corpora with equal counts must produce distinct keys so
// one config's filtered set never aliases another's.
const loadStopwords = (
  ctx: PipelineContext,
  corpus: NameCorpusData | null,
  corpusKey: string,
): Promise<ReadonlySet<string>> => {
  const inflight = ctx.stopwordsLoad;
  if (inflight && inflight.key === corpusKey) {
    return inflight.promise;
  }
  const promise = (async (): Promise<ReadonlySet<string>> => {
    try {
      const mod: { default?: string[] } =
        await import("../data/stopwords.json");
      const exclusions = buildFirstNameExclusions(corpus);
      const list = (mod.default ?? []).filter(
        (w: string) => !exclusions.has(w),
      );
      return new Set(list);
    } catch (err) {
      console.warn(
        "[anonymize] Failed to load stopwords.json" +
          " — stopword filtering disabled:",
        err,
      );
      return new Set<string>();
    }
  })();
  // Set the record synchronously before returning so a concurrent different-key
  // caller replaces it. The filtered set travels on `promise`, so each caller
  // reads its own config's stopwords; the shared `ctx.stopwords` slot is a
  // convenience written by the current record when it resolves.
  const record: KeyedLoad<ReadonlySet<string>> = { key: corpusKey, promise };
  ctx.stopwordsLoad = record;
  void promise.then((set) => {
    if (ctx.stopwordsLoad === record) {
      ctx.stopwords = set;
    }
  });
  return promise;
};

const EMPTY_STOPWORDS: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
const getStopwords = (ctx: PipelineContext): ReadonlySet<string> =>
  ctx.stopwords ?? EMPTY_STOPWORDS;

// ── Person stopwords (lazy-loaded from JSON) ─────────

const loadPersonStopwords = (
  ctx: PipelineContext,
): Promise<ReadonlySet<string>> => {
  if (ctx.personStopwordsPromise) {
    return ctx.personStopwordsPromise;
  }
  ctx.personStopwordsPromise = (async () => {
    try {
      const mod = await import("../data/person-stopwords.json");
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      const set: ReadonlySet<string> = new Set(
        collectLanguageWordValues(parsed as Record<string, unknown>),
      );
      ctx.personStopwords = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      ctx.personStopwords = empty;
      return empty;
    }
  })();
  return ctx.personStopwordsPromise;
};

const EMPTY_PERSON_STOPWORDS: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
export const getPersonStopwords = (ctx: PipelineContext): ReadonlySet<string> =>
  ctx.personStopwords ?? EMPTY_PERSON_STOPWORDS;

export const loadDefinedTermHeads = (
  ctx: PipelineContext,
): Promise<ReadonlySet<string>> => {
  if (ctx.definedTermHeadsPromise) {
    return ctx.definedTermHeadsPromise;
  }
  ctx.definedTermHeadsPromise = (async () => {
    try {
      const mod = await import("../data/defined-term-heads.json");
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      const set: ReadonlySet<string> = new Set(
        collectLanguageWordValues(parsed as Record<string, unknown>),
      );
      ctx.definedTermHeads = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      ctx.definedTermHeads = empty;
      return empty;
    }
  })();
  return ctx.definedTermHeadsPromise;
};

const EMPTY_DEFINED_TERM_HEADS: ReadonlySet<string> = new Set();

export const getDefinedTermHeads = (
  ctx: PipelineContext,
): ReadonlySet<string> => ctx.definedTermHeads ?? EMPTY_DEFINED_TERM_HEADS;

// ── Address stopwords (single-token city collisions) ──

const loadAddressStopwords = (
  ctx: PipelineContext,
): Promise<ReadonlySet<string>> => {
  if (ctx.addressStopwordsPromise) {
    return ctx.addressStopwordsPromise;
  }
  ctx.addressStopwordsPromise = (async () => {
    try {
      const mod: { default?: { words?: string[] } } =
        await import("../data/address-stopwords.json");
      const set: ReadonlySet<string> = new Set(mod.default?.words ?? []);
      ctx.addressStopwords = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      ctx.addressStopwords = empty;
      return empty;
    }
  })();
  return ctx.addressStopwordsPromise;
};

const EMPTY_ADDRESS_STOPWORDS: ReadonlySet<string> = new Set();

const getAddressStopwords = (ctx: PipelineContext): ReadonlySet<string> =>
  ctx.addressStopwords ?? EMPTY_ADDRESS_STOPWORDS;

/**
 * Word characters in unicode property notation. The check is
 * "single-token" — no internal whitespace — and we keep dashes
 * tokens like "K-12" out by requiring the surface to be a single
 * uninterrupted run of letters or marks.
 */
const SINGLE_WORD_RE = /^\p{L}+$/u;

/**
 * Format-level address signals — structurally numeric or
 * 2-letter-state patterns, language-agnostic. The street-type
 * vocabulary is loaded from `address-street-types.json` so new
 * languages contribute via data, not code.
 *   - `,\s*[A-Z]{2}\b` → US state abbreviation after a comma
 *   - `\b\d{5}(?:-\d{4})?\b` → US ZIP / ZIP+4
 *   - `\b\d{3}\s\d{2}\b` → Czech/Slovak postal block (140 00)
 *   - `\b\d{2}-\d{3}\b` → Polish postal code (00-950)
 */
const ADDRESS_FORMAT_RE =
  /,\s*\p{Lu}{2}\b|\b\d{5}(?:-\d{4})?\b|\b\d{3}\s\d{2}\b|\b\d{2}-\d{3}\b/u;

let cachedStreetTypeRe: RegExp | null = null;
let streetTypeReLoaded = false;

const loadStreetTypeRe = async (): Promise<RegExp | null> => {
  if (streetTypeReLoaded) return cachedStreetTypeRe;
  try {
    const mod: { default?: Record<string, unknown> } =
      await import("../data/address-street-types.json");
    const config = mod.default ?? {};
    const words: string[] = [];
    for (const value of Object.values(config)) {
      if (!Array.isArray(value)) continue;
      for (const word of value) {
        if (typeof word === "string" && word.length > 0) words.push(word);
      }
    }
    if (words.length === 0) {
      cachedStreetTypeRe = null;
    } else {
      words.sort((a, b) => b.length - a.length);
      const isLetterDigit = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
      const wordLikeTail: string[] = [];
      const punctTail: string[] = [];
      for (const w of words) {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const last = w.at(-1) ?? "";
        // Entries ending in a letter/digit need the trailing
        // negative lookahead to enforce a word boundary
        // (`Avenue` should not match inside `Avenues`). Entries
        // ending in punctuation like `Av.` or `C/` cannot
        // continue into another letter/digit and a trailing
        // lookahead would actually exclude valid forms such as
        // `C/Mayor` (no space).
        if (isLetterDigit(last)) {
          wordLikeTail.push(escaped);
        } else {
          punctTail.push(escaped);
        }
      }
      const branches: string[] = [];
      if (wordLikeTail.length > 0) {
        branches.push(`(?:${wordLikeTail.join("|")})(?![\\p{L}\\p{N}])`);
      }
      if (punctTail.length > 0) {
        branches.push(`(?:${punctTail.join("|")})`);
      }
      // Unicode-class lookarounds rather than `\b` so entries
      // ending in `.` or `/` (Spanish `Av.`, `C/`) still match
      // when followed by whitespace OR a letter (`C/Mayor`);
      // `\b` does not fire after non-word characters and a
      // uniform trailing lookahead would block the no-space
      // form.
      cachedStreetTypeRe = new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${branches.join("|")})`,
        "iu",
      );
    }
  } catch {
    cachedStreetTypeRe = null;
  }
  streetTypeReLoaded = true;
  return cachedStreetTypeRe;
};

const getStreetTypeRe = (): RegExp | null =>
  streetTypeReLoaded ? cachedStreetTypeRe : null;

const hasAdjacentAddressEvidence = (
  fullText: string,
  start: number,
  end: number,
): boolean => {
  const window = fullText.slice(
    Math.max(0, start - 40),
    Math.min(fullText.length, end + 40),
  );
  if (ADDRESS_FORMAT_RE.test(window)) return true;
  const streetRe = getStreetTypeRe();
  return streetRe !== null && streetRe.test(window);
};

type DenyListLanguageFilters = {
  sentenceStarters?: readonly string[];
  definedTermCues?: readonly string[];
};

type FalsePositiveShapeFilters = {
  addressComponentTerms: string[];
  ambiguousStreetTypeTerms: string[];
  numberAbbrevPrefixes: string[];
  documentHeadingOrdinalMarkers: string[];
};

type SigningClauseData = {
  patterns: readonly {
    guardPrefixPhrases?: readonly string[];
    guardSuffixPhrases?: readonly string[];
  }[];
};

export type DenyListFilterData = {
  stopwords: string[];
  allowList: string[];
  personStopwords: string[];
  personTrailingNouns: string[];
  addressStopwords: string[];
  addressJurisdictionPrefixes: string[];
  streetTypes: string[];
  addressComponentTerms: string[];
  ambiguousStreetTypeTerms: string[];
  firstNames: string[];
  genericRoles: string[];
  numberAbbrevPrefixes: string[];
  sentenceStarters: string[];
  trailingAddressWordExclusions: string[];
  documentHeadingWords: string[];
  documentHeadingOrdinalMarkers: string[];
  definedTermCues: string[];
  signingPlaceGuards: DenyListSigningPlaceGuardData[];
};

export type DenyListSigningPlaceGuardData = {
  prefixPhrases: string[];
  suffixPhrases: string[];
};

const DENY_LIST_FILTER_GROUPS: readonly DenyListLanguageFilters[] =
  Object.values(denyListFiltersByLanguage);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectLanguageFilterValues = (
  selector: (filters: DenyListLanguageFilters) => readonly string[] | undefined,
): string[] =>
  lowerSortedUnique(
    DENY_LIST_FILTER_GROUPS.flatMap((filters) => selector(filters) ?? []),
  );

const DENY_LIST_STATIC_FILTERS = {
  definedTermCues: collectLanguageFilterValues(
    (filters) => filters.definedTermCues,
  ),
  sentenceStarters: collectLanguageFilterValues(
    (filters) => filters.sentenceStarters,
  ),
};

const SENTENCE_STARTER_WORDS: ReadonlySet<string> = new Set(
  DENY_LIST_STATIC_FILTERS.sentenceStarters,
);

const buildDefinedTermCueRe = (): RegExp => {
  const cues = DENY_LIST_STATIC_FILTERS.definedTermCues.toSorted(
    (left, right) => right.length - left.length,
  );
  if (cues.length === 0) {
    return /$(?!)/;
  }
  const pattern = cues
    .map((cue) => escapeRegExp(cue).replace(/\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`^[\\s,]*(?:${pattern})\\b`, "iu");
};
const DEFINED_TERM_CUE_RE = buildDefinedTermCueRe();

const PERSON_CHAIN_BREAK_RE = /[!?;:]|,/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const CURATED_PATTERN_SYNTAX_RE = /[|\\]/g;

const stripCuratedPatternSyntax = (value: string): string =>
  value.includes("|") || value.includes("\\")
    ? value.replace(CURATED_PATTERN_SYNTAX_RE, "")
    : value;

const isInitialContinuationGap = (text: string, gap: string): boolean =>
  (/^\p{Lu}$/u.test(text) && /^\.[^\S\n]{1,2}$/u.test(gap)) ||
  /^[^\S\n]{1,2}(?:\p{Lu}\.[^\S\n]{1,2})+$/u.test(gap);

/**
 * Source tag for each pattern in the automaton.
 * "deny-list" = standard deny list entry
 * "city" = city dictionary entry
 * "custom-deny-list" = caller-owned exact term
 * "first-name" = name corpus first name
 * "surname" = name corpus surname
 * "title" = academic/professional title
 */
type PatternSource =
  | "deny-list"
  | "city"
  | "custom-deny-list"
  | "first-name"
  | "surname"
  | "title";

type PatternLabels = string | string[];
type PatternSources = PatternSource | PatternSource[];

const EMPTY_PATTERN_LABELS: readonly string[] = [];
const EMPTY_PATTERN_SOURCES: readonly PatternSource[] = [];

const patternLabels = (
  labels: PatternLabels | undefined,
): readonly string[] => {
  if (labels === undefined) {
    return EMPTY_PATTERN_LABELS;
  }
  return Array.isArray(labels) ? labels : [labels];
};

const patternSources = (
  sources: PatternSources | undefined,
): readonly PatternSource[] => {
  if (sources === undefined) {
    return EMPTY_PATTERN_SOURCES;
  }
  return Array.isArray(sources) ? sources : [sources];
};

const hasPersonNameSource = (match: RawMatch): boolean =>
  match.sources.includes("first-name") || match.sources.includes("surname");

const addPatternLabel = (
  list: PatternLabels[],
  index: number,
  label: string,
): void => {
  const existing = list[index];
  if (existing === undefined) {
    list[index] = label;
    return;
  }
  if (Array.isArray(existing)) {
    if (!existing.includes(label)) {
      existing.push(label);
    }
    return;
  }
  if (existing !== label) {
    list[index] = [existing, label];
  }
};

const addPatternSource = (
  list: PatternSources[],
  index: number,
  source: PatternSource,
): void => {
  const existing = list[index];
  if (existing === undefined) {
    list[index] = source;
    return;
  }
  if (Array.isArray(existing)) {
    if (!existing.includes(source)) {
      existing.push(source);
    }
    return;
  }
  if (existing !== source) {
    list[index] = [existing, source];
  }
};

const addOptionalPatternLabel = (
  list: (PatternLabels | undefined)[],
  index: number,
  label: string,
): void => {
  const existing = list[index];
  if (existing === undefined) {
    list[index] = label;
    return;
  }
  if (Array.isArray(existing)) {
    if (!existing.includes(label)) {
      existing.push(label);
    }
    return;
  }
  if (existing !== label) {
    list[index] = [existing, label];
  }
};

/**
 * Pre-built deny list data. Constructed once by
 * `buildDenyList`, reused across `processDenyListMatches`
 * calls. Contains PatternEntry[] for the unified builder
 * plus parallel label/source arrays for post-processing.
 */
export type DenyListData = {
  /**
   * Maps pattern index → entity labels (plural).
   * Same pattern can have multiple labels when it
   * appears in multiple dictionaries (e.g., "Denver"
   * is both a person name and a city name).
   */
  labels: PatternLabels[];
  /** Maps pattern index → labels contributed by custom entries. */
  customLabels: (PatternLabels | undefined)[];
  /** Maps pattern index → original pattern text. */
  originals: string[];
  /** Maps pattern index → source types (plural). */
  sources: PatternSources[];
  filters: DenyListFilterData;
};

const getCityEntries = (
  dictionaries: Dictionaries | undefined,
  allowedCountries: ReadonlySet<string> | null,
): readonly string[] => {
  const byCountry = dictionaries?.citiesByCountry;
  if (!byCountry) {
    return dictionaries?.cities ?? [];
  }

  const result: string[] = [];
  const append = (entries: readonly string[] | undefined) => {
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      result.push(entry);
    }
  };

  if (allowedCountries === null) {
    for (const entries of Object.values(byCountry)) {
      append(entries);
    }
    return result;
  }

  for (const country of allowedCountries) {
    append(byCountry[country.toUpperCase()]);
  }

  return result;
};

/**
 * Resolve which dictionaries to load based on country
 * and category filters, then build the deny list data.
 * The returned data provides PatternEntry[] for the
 * unified builder and parallel arrays for
 * post-processing.
 *
 * Dictionary data is injected via `config.dictionaries`.
 * Returns null if no dictionaries are provided.
 */
export const buildDenyList = async (
  config: DenyListConfig,
  ctx: PipelineContext = defaultContext,
): Promise<DenyListData | null> => {
  // Resolve the name corpus for THIS config before stopword filtering and the
  // corpus-derived deny-list entries. Hold the resolved value locally so a
  // concurrent config building on the same context cannot swap it out from
  // under us (the shared ctx.nameCorpus slot may move to a different config).
  const corpusKey = nameCorpusCacheKey(
    config.dictionaries,
    config.nameCorpusLanguages,
  );
  const corpus = await initNameCorpus(
    ctx,
    config.dictionaries,
    config.nameCorpusLanguages,
  );
  // Pre-load all JSON data so sync accessors are
  // populated before processDenyListMatches runs.
  const [stopwords] = await Promise.all([
    loadStopwords(ctx, corpus, corpusKey),
    loadAllowList(ctx),
    loadPersonStopwords(ctx),
    loadDefinedTermHeads(ctx),
    loadAddressStopwords(ctx),
    loadCommonWords(),
    loadMonthNames(),
    loadStreetTypeRe(),
    loadGenericRoles(ctx),
    warmLegalRoleHeads(),
    loadTrailingAddressWordExclusions(),
  ]);
  const commonWords = await loadCommonWords();
  const monthNames = await loadMonthNames();
  const filters = await buildDenyListFilterData(ctx, corpus, stopwords);

  const dictionaries = config.dictionaries;
  const hasDenyList = dictionaries?.denyList && dictionaries?.denyListMeta;
  const hasCustomDenyList =
    config.customDenyList !== undefined && config.customDenyList.length > 0;
  const allowedCountries = resolveCountries(
    config.denyListRegions,
    config.denyListCountries,
  );
  const cityEntries = getCityEntries(dictionaries, allowedCountries);
  const hasCities = cityEntries.length > 0;

  // No dictionary data available — skip deny-list building
  if (!hasDenyList && !hasCities && !hasCustomDenyList) {
    // Still build name corpus entries if available
    return buildNameCorpusOnly(config, corpus, filters);
  }

  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded ? new Set(excluded) : new Set<string>();

  const patternList: string[] = [];
  const labelList: PatternLabels[] = [];
  const customLabelList: (PatternLabels | undefined)[] = [];
  const sourceList: PatternSources[] = [];
  // Maps lowercased pattern → index in patternList
  // for accumulating labels from multiple dictionaries
  const patternIndex = new Map<string, number>();

  const addDenyListEntry = (
    entry: string,
    label: string,
    source: PatternSource = "deny-list",
  ) => {
    // Strip | and \ only for curated data — these caused the 12K FP
    // bug (| creates empty regex alternation, \ is
    // an escape prefix). Caller-owned custom terms stay exact.
    const normalized =
      source === "custom-deny-list"
        ? normalizeForSearch(entry)
        : stripCuratedPatternSyntax(normalizeForSearch(entry));
    if (normalized.length === 0) {
      return;
    }
    const lower = normalized.toLowerCase();
    if (source !== "custom-deny-list") {
      if (label !== "address") {
        if (SINGLE_WORD_RE.test(normalized) && commonWords.has(lower)) {
          return;
        }
        if (isShortCuratedNoiseAcronym(normalized)) {
          return;
        }
      } else if (monthNames.has(lower)) {
        // Some city gazetteer entries collide with month words
        // (e.g. a place named "August"); in prose these are
        // overwhelmingly dates, so they surface as address false
        // positives. The common-word filter is deliberately not
        // applied to addresses (most cities are ordinary words),
        // so month words are dropped explicitly instead.
        return;
      }
    }
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      addPatternLabel(labelList, existing, label);
      addPatternSource(sourceList, existing, source);
      if (
        source === "custom-deny-list" &&
        !patternLabels(customLabelList[existing]).includes(label)
      ) {
        addOptionalPatternLabel(customLabelList, existing, label);
      }
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(normalized);
      labelList.push(label);
      if (source === "custom-deny-list") {
        customLabelList[patternList.length - 1] = label;
      }
      sourceList.push(source);
    }
  };

  // Load dictionaries from injected data
  if (hasDenyList) {
    const denyListData = dictionaries.denyList!;
    const metaData = dictionaries.denyListMeta!;
    const useScopedNameCorpus = config.nameCorpusLanguages !== undefined;

    for (const [id, entries] of Object.entries(denyListData)) {
      const meta: DictionaryMeta | undefined = metaData[id];
      if (!meta) {
        continue;
      }

      if (!config.enableNameCorpus && meta.category === "Names") {
        continue;
      }

      if (useScopedNameCorpus && meta.category === "Names") {
        continue;
      }

      if (excludeCategories.has(meta.category)) {
        continue;
      }

      // enableCountries: false must zero-out country redaction
      // across both the new country detector and the legacy
      // `countries/translations` dictionary, which ships Czech
      // declensions ("České republiky", "Slovenskou republikou",
      // …) the CLDR canonicals don't carry. Without this gate,
      // toggling the flag would silently keep the legacy path
      // active.
      if (meta.label === "country" && config.enableCountries === false) {
        continue;
      }

      if (allowedCountries !== null && meta.country !== null) {
        if (!allowedCountries.has(meta.country)) {
          continue;
        }
      }

      for (const entry of entries) {
        addDenyListEntry(entry, meta.label);
      }
    }
  }

  // Add pre-loaded city entries
  if (hasCities && !excludeCategories.has("Places")) {
    for (const entry of cityEntries) {
      addDenyListEntry(entry, "address", "city");
    }
  }

  if (hasCustomDenyList) {
    for (const entry of config.customDenyList!) {
      addDenyListEntry(entry.value, entry.label, "custom-deny-list");
      for (const variant of entry.variants ?? []) {
        addDenyListEntry(variant, entry.label, "custom-deny-list");
      }
    }
  }

  // Add name corpus entries — accumulate labels
  // for entries that already exist from deny-list.
  appendNameCorpusEntries(
    config,
    corpus,
    patternList,
    labelList,
    sourceList,
    patternIndex,
  );

  if (patternList.length === 0) {
    return null;
  }

  return {
    labels: labelList,
    customLabels: customLabelList,
    originals: patternList,
    sources: sourceList,
    filters,
  };
};

/**
 * Build deny-list data containing only name corpus
 * entries (no external dictionaries). Used when no
 * dictionary data is injected but name corpus is
 * enabled.
 */
const buildNameCorpusOnly = (
  config: DenyListConfig,
  corpus: NameCorpusData | null,
  filters: DenyListFilterData,
): DenyListData | null => {
  if (!config.enableNameCorpus) {
    return null;
  }

  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded ? new Set(excluded) : new Set<string>();
  if (excludeCategories.has("Names")) {
    return null;
  }

  const patternList: string[] = [];
  const labelList: PatternLabels[] = [];
  const customLabelList: (PatternLabels | undefined)[] = [];
  const sourceList: PatternSources[] = [];
  const patternIndex = new Map<string, number>();

  appendNameCorpusEntries(
    config,
    corpus,
    patternList,
    labelList,
    sourceList,
    patternIndex,
  );

  if (patternList.length === 0) {
    return null;
  }

  return {
    labels: labelList,
    customLabels: customLabelList,
    originals: patternList,
    sources: sourceList,
    filters,
  };
};

/**
 * Append name corpus entries (first names, surnames,
 * titles) to the pattern arrays. Shared between
 * buildDenyList and buildNameCorpusOnly.
 */
const appendNameCorpusEntries = (
  config: DenyListConfig,
  corpus: NameCorpusData | null,
  patternList: string[],
  labelList: PatternLabels[],
  sourceList: PatternSources[],
  patternIndex: Map<string, number>,
): void => {
  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded ? new Set(excluded) : new Set<string>();

  if (!config.enableNameCorpus || excludeCategories.has("Names")) {
    return;
  }

  const addNameEntry = (name: string, source: PatternSource) => {
    // Normalize same as deny-list entries so name
    // patterns match against normalizeForSearch(text).
    const normalized = stripCuratedPatternSyntax(normalizeForSearch(name));
    if (normalized.length === 0) {
      return;
    }
    if (isCuratedNoiseAcronym(normalized)) {
      return;
    }
    const lower = normalized.toLowerCase();
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      addPatternLabel(labelList, existing, "person");
      addPatternSource(sourceList, existing, source);
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(normalized);
      labelList.push("person");
      sourceList.push(source);
    }
  };

  // Inject declined Czech/Slovak variants alongside the
  // nominative so the whole-word AC search matches names
  // in running declined text ("s Janem Novákem"). Variant
  // generation is gated by ending shape, which bounds the
  // pattern-count growth. Variants that collide with
  // common English words are dropped, mirroring the
  // surname curation in initNameCorpus.
  const commonWords = getCommonWords();
  const addDeclinedVariants = (name: string, source: PatternSource) => {
    for (const variant of expandNameDeclensions(name)) {
      if (commonWords.has(variant.toLowerCase())) {
        continue;
      }
      addNameEntry(variant, source);
    }
  };
  for (const name of corpus?.firstNamesList ?? []) {
    addNameEntry(name, "first-name");
    addDeclinedVariants(name, "first-name");
  }
  for (const name of corpus?.surnamesList ?? []) {
    addNameEntry(name, "surname");
    addDeclinedVariants(name, "surname");
  }
  for (const title of corpus?.titlesList ?? []) {
    const norm = stripCuratedPatternSyntax(normalizeForSearch(title));
    if (norm.length === 0) continue;
    const lower = norm.toLowerCase();
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      addPatternSource(sourceList, existing, "title");
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(norm);
      labelList.push("person");
      sourceList.push("title");
    }
  }
};

type RawMatch = {
  start: number;
  end: number;
  /** All labels for this pattern (e.g., ["person", "address"]). */
  labels: readonly string[];
  customLabels: readonly string[];
  sources: readonly PatternSource[];
  text: string;
  patternIdx: number;
};

const buildStreetTypeFilterValues = async (): Promise<string[]> =>
  lowerSortedUnique(await buildStreetTypePatterns());

type SigningPlaceFilters = {
  guards: DenyListSigningPlaceGuardData[];
};

let signingPlaceFiltersPromise: Promise<SigningPlaceFilters> | null = null;

const loadSigningPlaceFilters = (): Promise<SigningPlaceFilters> => {
  if (signingPlaceFiltersPromise) {
    return signingPlaceFiltersPromise;
  }

  signingPlaceFiltersPromise = (async () => {
    const mod = await import("../data/signing-clauses.json");
    const data: SigningClauseData = mod.default ?? mod;
    return {
      guards: data.patterns
        .map((entry) => ({
          prefixPhrases: lowerSortedUnique(entry.guardPrefixPhrases ?? []),
          suffixPhrases: lowerSortedUnique(entry.guardSuffixPhrases ?? []),
        }))
        .filter(
          (entry) =>
            entry.prefixPhrases.length > 0 && entry.suffixPhrases.length > 0,
        ),
    };
  })().catch((error) => {
    signingPlaceFiltersPromise = null;
    throw error;
  });

  return signingPlaceFiltersPromise;
};

let trailingAddressWordExclusionsPromise: Promise<ReadonlySet<string>> | null =
  null;
let documentHeadingWordsPromise: Promise<string[]> | null = null;
let addressJurisdictionPrefixesPromise: Promise<string[]> | null = null;

const loadLanguageWordFile = async (
  importer: () => Promise<unknown>,
): Promise<string[]> => {
  const mod = await importer();
  const parsed = (mod as { default?: Record<string, unknown> }).default ?? mod;
  return collectLanguageWordValues(parsed as Record<string, unknown>);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const languageWordValues = (value: unknown): string[] =>
  isRecord(value) ? collectLanguageWordValues(value) : [];

let falsePositiveShapeFiltersPromise: Promise<FalsePositiveShapeFilters> | null =
  null;

const loadFalsePositiveShapeFilters =
  (): Promise<FalsePositiveShapeFilters> => {
    if (falsePositiveShapeFiltersPromise) {
      return falsePositiveShapeFiltersPromise;
    }

    falsePositiveShapeFiltersPromise = (async () => {
      const mod = await import("../data/false-positive-shapes.json");
      const defaultValue = isRecord(mod) ? mod.default : undefined;
      let data: Record<string, unknown> = {};
      if (isRecord(defaultValue)) {
        data = defaultValue;
      } else if (isRecord(mod)) {
        data = mod;
      }
      return {
        addressComponentTerms: languageWordValues(
          data["addressComponentTerms"],
        ),
        ambiguousStreetTypeTerms: languageWordValues(
          data["ambiguousStreetTypeTerms"],
        ),
        numberAbbrevPrefixes: languageWordValues(data["numberAbbrevPrefixes"]),
        documentHeadingOrdinalMarkers: languageWordValues(
          data["documentHeadingOrdinalMarkers"],
        ),
      };
    })().catch((error) => {
      falsePositiveShapeFiltersPromise = null;
      throw error;
    });

    return falsePositiveShapeFiltersPromise;
  };

const loadDocumentHeadingWords = (): Promise<string[]> => {
  if (documentHeadingWordsPromise) {
    return documentHeadingWordsPromise;
  }

  documentHeadingWordsPromise = loadLanguageWordFile(
    () => import("../data/document-structure-headings.json"),
  ).catch((error) => {
    documentHeadingWordsPromise = null;
    throw error;
  });

  return documentHeadingWordsPromise;
};

const loadTrailingAddressWordExclusions = async (): Promise<
  ReadonlySet<string>
> => {
  if (trailingAddressWordExclusionsPromise) {
    return trailingAddressWordExclusionsPromise;
  }

  trailingAddressWordExclusionsPromise = (async () => {
    await warmLegalRoleHeads();
    const [organizationUnits, documentHeadings] = await Promise.all([
      loadLanguageWordFile(
        () => import("../data/organization-unit-heads.json"),
      ),
      loadDocumentHeadingWords(),
    ]);
    return new Set(
      lowerSortedUnique([
        ...getLegalRoleHeadsSync(),
        ...getClauseNounHeadsSync(),
        ...organizationUnits,
        ...documentHeadings,
      ]),
    );
  })().catch((error) => {
    trailingAddressWordExclusionsPromise = null;
    throw error;
  });

  return trailingAddressWordExclusionsPromise;
};

const loadAddressJurisdictionPrefixes = (): Promise<string[]> => {
  if (addressJurisdictionPrefixesPromise) {
    return addressJurisdictionPrefixesPromise;
  }

  addressJurisdictionPrefixesPromise = loadLanguageWordFile(
    () => import("../data/address-jurisdiction-prefixes.json"),
  ).catch((error) => {
    addressJurisdictionPrefixesPromise = null;
    throw error;
  });

  return addressJurisdictionPrefixesPromise;
};

export const buildDenyListFilterData = async (
  ctx: PipelineContext,
  corpus: NameCorpusData | null,
  stopwords: ReadonlySet<string>,
): Promise<DenyListFilterData> => {
  const [
    signingPlaceFilters,
    trailingAddressWordExclusions,
    addressJurisdictionPrefixes,
    falsePositiveShapeFilters,
    documentHeadingWords,
  ] = await Promise.all([
    loadSigningPlaceFilters(),
    loadTrailingAddressWordExclusions(),
    loadAddressJurisdictionPrefixes(),
    loadFalsePositiveShapeFilters(),
    loadDocumentHeadingWords(),
  ]);

  return {
    // stopwords + firstNames come from the config's own corpus load, threaded
    // in so a concurrent config building on this context cannot substitute its
    // corpus via the shared ctx slots. The remaining sets are config-independent
    // static data and are safe to read from ctx.
    stopwords: [...stopwords],
    allowList: [...getAllowList(ctx)],
    personStopwords: [...getPersonStopwords(ctx)],
    personTrailingNouns: [...getDefinedTermHeads(ctx)],
    addressStopwords: [...getAddressStopwords(ctx)],
    addressJurisdictionPrefixes,
    streetTypes: await buildStreetTypeFilterValues(),
    addressComponentTerms: falsePositiveShapeFilters.addressComponentTerms,
    ambiguousStreetTypeTerms:
      falsePositiveShapeFilters.ambiguousStreetTypeTerms,
    firstNames: [...(corpus?.firstNamesList ?? [])],
    genericRoles: [
      ...(ctx.genericRoles ?? EMPTY_GENERIC_ROLES),
      ...getLegalRoleHeadsSync(),
    ],
    numberAbbrevPrefixes: falsePositiveShapeFilters.numberAbbrevPrefixes,
    sentenceStarters: [...DENY_LIST_STATIC_FILTERS.sentenceStarters],
    trailingAddressWordExclusions: [...trailingAddressWordExclusions],
    documentHeadingWords,
    documentHeadingOrdinalMarkers:
      falsePositiveShapeFilters.documentHeadingOrdinalMarkers,
    definedTermCues: [...DENY_LIST_STATIC_FILTERS.definedTermCues],
    signingPlaceGuards: signingPlaceFilters.guards.map((entry) => ({
      prefixPhrases: [...entry.prefixPhrases],
      suffixPhrases: [...entry.suffixPhrases],
    })),
  };
};

const customMatchHasValidEdges = (
  fullText: string,
  start: number,
  end: number,
  pattern: string,
): boolean => {
  if (!WORD_CHAR_RE.test(pattern)) {
    return true;
  }
  const prev = fullText[start - 1] ?? "";
  const next = fullText[end] ?? "";
  if (WORD_CHAR_RE.test(prev)) {
    return false;
  }
  if (WORD_CHAR_RE.test(next)) {
    return false;
  }
  return true;
};

/** Resolved corpus + stopwords for a config, so callers can thread the
 *  config's own values into buildDenyListFilterData / the corpus bake rather
 *  than re-reading the shared, concurrently-mutated ctx slots. */
export type EnsuredDenyListData = {
  corpus: NameCorpusData | null;
  stopwords: ReadonlySet<string>;
};

/**
 * Ensure all deny-list support data (stopwords, allow
 * list, person stopwords, generic roles) is loaded on
 * the given context. Call this before
 * processDenyListMatches / filterFalsePositives when
 * the search instance was built on a different context
 * (e.g. cachedSearch).
 *
 * Returns the config's resolved corpus and stopwords; the caller should thread
 * these rather than reading ctx, so a concurrent config cannot substitute its
 * values through the shared slots.
 */
export const ensureDenyListData = async (
  ctx: PipelineContext = defaultContext,
  dictionaries?: Dictionaries,
  nameCorpusLanguages?: readonly string[],
): Promise<EnsuredDenyListData> => {
  // INVARIANT: initNameCorpus must resolve before
  // loadStopwords so first-name exclusions are
  // available when computing the stopword set.
  const corpusKey = nameCorpusCacheKey(dictionaries, nameCorpusLanguages);
  const corpus = await initNameCorpus(ctx, dictionaries, nameCorpusLanguages);
  const [stopwords] = await Promise.all([
    loadStopwords(ctx, corpus, corpusKey),
    loadAllowList(ctx),
    loadPersonStopwords(ctx),
    loadDefinedTermHeads(ctx),
    loadAddressStopwords(ctx),
    loadStreetTypeRe(),
    loadGenericRoles(ctx),
    warmLegalRoleHeads(),
    loadTrailingAddressWordExclusions(),
    loadAddressJurisdictionPrefixes(),
  ]);
  return { corpus, stopwords };
};

// ── Match processor ─────────────────────────────────

/**
 * Process deny list matches from the unified search.
 * Receives all matches; filters to the deny list slice
 * via sliceStart/sliceEnd. Local index into data.labels,
 * data.originals, data.sources is match.pattern - sliceStart.
 *
 * Two-pass approach to reduce false positives:
 * 1. Collect all matches (case-insensitive,
 *    whole-word via Rust automaton)
 * 2. Require uppercase start in source text
 * 3. For person names, require at least one
 *    mid-sentence occurrence to prove proper noun
 * 4. Return all occurrences of validated terms
 */
export const processDenyListMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  data: DenyListData,
  ctx: PipelineContext = defaultContext,
): Entity[] => {
  // Pass 1: collect valid matches grouped by pattern
  const matchesByPattern = new Map<number, RawMatch[]>();

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const localIdx = idx - sliceStart;
    const sources = patternSources(data.sources[localIdx]);

    // Use original text for display; normalized was
    // only for the AC search.
    const matchText = fullText.slice(match.start, match.end);
    const sourceChar = fullText[match.start] ?? "";
    const keyword = matchText.toLowerCase();

    const labels = patternLabels(data.labels[localIdx]);
    const pattern = data.originals[localIdx] ?? "";
    const customPatternLabels = patternLabels(data.customLabels[localIdx]);
    const customEdgesAreValid = customMatchHasValidEdges(
      fullText,
      match.start,
      match.end,
      pattern,
    );
    const customLabels = customEdgesAreValid ? customPatternLabels : [];
    if (labels.length === 0 && customLabels.length === 0) {
      continue;
    }

    // All-uppercase acronym patterns ("OIL", "OP", "BIS")
    // case-fold to common English words under the AC's
    // caseInsensitive flag and match mixed-case occurrences
    // ("Oil", "Op"). Require all-uppercase patterns to
    // match all-uppercase source text so acronym dictionary
    // entries cannot collide with everyday prose.
    const patternIsAcronym =
      pattern.length > 0 && pattern.length <= 5 && ALL_UPPER_RE.test(pattern);
    const acronymMatchesAcronym =
      !patternIsAcronym || ALL_UPPER_RE.test(matchText);

    const passesCuratedFilters =
      UPPER_START_RE.test(sourceChar) &&
      !getStopwords(ctx).has(keyword) &&
      !getAllowList(ctx).has(keyword) &&
      acronymMatchesAcronym &&
      !ALL_UPPER_RE.test(matchText);
    const curatedLabels = passesCuratedFilters
      ? labels.filter(
          (label) =>
            !customPatternLabels.includes(label) && customEdgesAreValid,
        )
      : [];
    const suffixCollision = isDottedAcronymSuffixCollision(
      fullText,
      match.start,
      matchText,
    );
    const filteredCuratedLabels = suffixCollision ? [] : curatedLabels;

    if (filteredCuratedLabels.length === 0 && customLabels.length === 0) {
      continue;
    }

    const entry: RawMatch = {
      start: match.start,
      end: match.end,
      labels: filteredCuratedLabels,
      customLabels,
      sources,
      text: matchText,
      patternIdx: localIdx,
    };

    const existing = matchesByPattern.get(localIdx);
    if (existing) {
      existing.push(entry);
    } else {
      matchesByPattern.set(localIdx, [entry]);
    }
  }

  // Pass 2: process all matches
  const results: Entity[] = [];
  const nameHits: RawMatch[] = [];

  for (const [, matches] of Array.from(matchesByPattern)) {
    const first = matches[0];
    if (!first) {
      continue;
    }

    for (const m of matches) {
      for (const label of m.customLabels) {
        results.push({
          start: m.start,
          end: m.end,
          label,
          text: m.text,
          score: 0.9,
          source: DETECTION_SOURCES.DENY_LIST,
          sourceDetail: "custom-deny-list",
        });
      }
    }

    // Curated labels are evaluated per match because
    // custom-only matches can share a pattern with
    // curated matches while failing curated FP filters.
    for (const m of matches) {
      if (m.labels.includes("person")) {
        const keyword = m.text.toLowerCase();
        if (!getPersonStopwords(ctx).has(keyword)) {
          nameHits.push(m);
        }
      }

      const nonPersonLabels = m.labels.filter((l) => l !== "person");
      // Single-token city-dictionary collisions (Price, Union,
      // Brent, Time, …) are common English words that GeoNames
      // also knows as tiny villages. Drop them so "Purchase
      // Price" / "European Union" prose stops getting tagged
      // as an address — but only when there's no surrounding
      // address context. "Union, WA 98592" or "Price, UT" stay,
      // because a state abbreviation or ZIP nearby confirms the
      // city interpretation.
      const isStopwordSingleAddress =
        SINGLE_WORD_RE.test(m.text) &&
        getAddressStopwords(ctx).has(m.text.toLowerCase());
      const suppressAddress =
        isStopwordSingleAddress &&
        !hasAdjacentAddressEvidence(fullText, m.start, m.end);
      for (const label of nonPersonLabels) {
        if (label === "address" && suppressAddress) {
          continue;
        }
        results.push({
          start: m.start,
          end: m.end,
          label,
          text: m.text,
          score: 0.9,
          source: DETECTION_SOURCES.DENY_LIST,
        });
      }
    }
  }

  // Pass 2b: person hits — chain adjacent hits and
  // extend to following capitalised words.
  nameHits.sort((a, b) => a.start - b.start);

  const nameConsumed = new Set<number>();
  for (let i = 0; i < nameHits.length; i++) {
    if (nameConsumed.has(i)) {
      continue;
    }
    const hit = nameHits[i];
    if (!hit) {
      continue;
    }

    // Build chain of adjacent person hits
    const chain: RawMatch[] = [hit];
    let j = i + 1;

    while (j < nameHits.length && chain.length < 5) {
      const next = nameHits[j];
      if (!next) {
        break;
      }
      const prev = chain.at(-1);
      if (!prev) {
        break;
      }

      const gap = fullText.slice(prev.end, next.start);
      const breaksOnPeriod =
        gap.includes(".") && !isInitialContinuationGap(prev.text, gap);
      if (
        gap.length > 4 ||
        gap.length === 0 ||
        gap.includes("\n") ||
        gap.includes("\t") ||
        PERSON_CHAIN_BREAK_RE.test(gap) ||
        breaksOnPeriod
      ) {
        break;
      }

      chain.push(next);
      j++;
    }

    // Mark chain members consumed
    for (let k = i; k < i + chain.length; k++) {
      nameConsumed.add(k);
    }

    // Extend to following capitalised word (for
    // unknown surnames not in the corpus)
    const first = chain.at(0);
    const last = chain.at(-1);
    if (!first || !last) {
      continue;
    }
    if (!chain.some(hasPersonNameSource)) {
      continue;
    }

    // Skip extension inside quoted defined-term contexts:
    // legal prose often uses quoted capitalised noun phrases
    // that are not personal names.
    const insideDefinedTermQuote = isSuppressibleDefinedTermQuote(
      fullText,
      first.start,
      ctx,
    );

    if (insideDefinedTermQuote) {
      continue;
    }

    const extended = extendPersonName(fullText, first.start, last.end, ctx);

    // Score: chained names get 0.9, single names 0.5
    const score = chain.length >= 2 ? 0.9 : 0.5;

    // Single-word deny-list matches are noisy. Only accept
    // them when the next token has the shape of a name word,
    // while excluding language-data sentence starters.
    if (chain.length === 1) {
      const afterEnd = last.end;
      const rest = fullText.slice(afterEnd).trimStart();
      // Require Cap + lowercase so acronym-shaped tokens
      // do not promote a single-token hit.
      const nextIsUpper = rest.length > 1 && /^\p{Lu}\p{Ll}/u.test(rest);
      if (!nextIsUpper) {
        continue;
      }
      // Reject sentence starters so headings followed by
      // prose do not get promoted to person hits.
      const nextWord = /^\p{L}+/u.exec(rest)?.[0] ?? "";
      if (SENTENCE_STARTER_WORDS.has(nextWord.toLowerCase())) {
        continue;
      }
    }

    results.push({
      start: first.start,
      end: extended.end,
      label: "person",
      text: extended.text,
      score,
      source: DETECTION_SOURCES.DENY_LIST,
    });
  }

  // Post-process: extend city/address matches to
  // include adjacent trailing district numbers (e.g.,
  // "Praha 1", "Brno 2"). Czech and Slovak cities
  // commonly have numbered districts that are part of
  // the address.
  extendCityDistricts(
    results,
    fullText,
    new Set(data.filters.trailingAddressWordExclusions),
  );

  return results;
};

/**
 * Extend address-label entities to absorb adjacent
 * integers: trailing district numbers ("Praha 1") and
 * leading postal codes ("80336 München").
 * Mutates the entities in place.
 */
// District suffixes: digits ("Praha 1") or Roman
// numerals ("Příbram II", "Brno III")
// Valid Roman numerals only (I-XXX range, no invalid
// combos like IC, LC, VC). Covers district suffixes
// up to Praha XXX which is more than enough.
// Roman numeral district suffixes II-XXX. Standalone
// "I" and "V" excluded: "V" clashes with Czech
// preposition "in"; "I" is too ambiguous.
const ROMAN_DISTRICT =
  "XXX|XXIX|XXVIII|XXVII|XXVI|XXV|XXIV|XXIII" +
  "|XXII|XXI|XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII" +
  "|XII|XI|X|IX|VIII|VII|VI|IV|III|II";
const DISTRICT_SUFFIX_RE = new RegExp(
  `^ (\\d{1,2}(?!\\d)|(?:${ROMAN_DISTRICT}))` + `(?=[\\s,;.)"\\n]|$)`,
);
// Postal code before city: "163 00 ", "16300 ",
// "16300 - " (with dash separator).
const POSTAL_PREFIX_RE = new RegExp(
  `(?:\\d{5}|\\d{3}\\s\\d{2})\\s*${DASH}?\\s*$`,
);

const extendCityDistricts = (
  entities: Entity[],
  fullText: string,
  trailingAddressWordExclusions: ReadonlySet<string>,
): void => {
  for (const entity of entities) {
    if (entity.label !== "address") {
      continue;
    }
    if (entity.sourceDetail === "custom-deny-list") {
      continue;
    }

    // Trailing: "Praha" + " 1" → "Praha 1"
    // Trailing: "Praha" + " 1" → "Praha 1"
    const afterMatch = fullText.slice(entity.end);
    const suffixM = DISTRICT_SUFFIX_RE.exec(afterMatch);
    if (suffixM) {
      entity.end += suffixM[0].length;
      entity.text = fullText.slice(entity.start, entity.end);
    }

    // Dash-separated district name:
    // "Praha 10 - Strašnice", "Havířov – Město"
    const afterDistrict = fullText.slice(entity.end);
    const dashDistrictM = /^[ \t]{1,4}[-–][ \t]*(\p{Lu}\p{Ll}+)/u.exec(
      afterDistrict,
    );
    if (dashDistrictM && !dashDistrictM[0].includes("\n")) {
      entity.end += dashDistrictM[0].length;
      entity.text = fullText.slice(entity.start, entity.end);
    }

    // Leading: "80336 " + "München" → "80336 München"
    // Absorbs 3-5 digit postal codes before the city.
    const beforeMatch = fullText.slice(
      Math.max(0, entity.start - 10),
      entity.start,
    );
    const prefixM = POSTAL_PREFIX_RE.exec(beforeMatch);
    if (prefixM) {
      entity.start -= prefixM[0].length;
      entity.text = fullText.slice(entity.start, entity.end);
    }

    // Trailing uppercase word: "434 01" + " Most" →
    // "434 01 Most". Absorb if the next word starts
    // with uppercase and is on the same line.
    // Guard: skip party-role or organizational terms.
    const afterExt = fullText.slice(entity.end);
    // Max 4 spaces gap — more means different column
    const trailingWordM = /^[\s]{1,4}(\p{Lu}\p{Ll}+)/u.exec(afterExt);
    if (trailingWordM && !trailingWordM[0].includes("\n")) {
      const candidate = (trailingWordM[1] ?? "").toLowerCase();
      if (!trailingAddressWordExclusions.has(candidate)) {
        entity.end += trailingWordM[0].length;
        entity.text = fullText.slice(entity.start, entity.end);
      }
    }
  }
};

/**
 * Extend a person name match to include subsequent
 * capitalized words. Stops at lowercase words,
 * punctuation, or end of text.
 */
/**
 * Defined-term marker: an opening typographic or straight
 * quote enclosing the chain start, AND a closing quote
 * within a short window followed by a language-data
 * definitional cue. Legal documents reserve this
 * construction for defined terms; the contents are not
 * personal names even when individual tokens collide with
 * the name corpus.
 */
const OPENING_QUOTES = new Set(['"', "'", "“", "„", "‟", "‘", "‛", "«"]);
const CLOSING_QUOTES = new Set(['"', "'", "”", "’", "»", "“"]);
const DEFINED_TERM_LOOKAHEAD = 120;
const DEFINED_TERM_LOOKBEHIND = 80;
const EMPTY_GENERIC_ROLES: ReadonlySet<string> = new Set();

type DefinedTermQuote = {
  content: string;
  afterClosingQuote: string;
};

const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && /^\p{L}$/u.test(ch);

const isApostropheInsideWord = (text: string, index: number): boolean =>
  isLetter(text[index - 1]) && isLetter(text[index + 1]);

const isQuoteBoundary = (text: string, index: number): boolean => {
  const ch = text[index];
  if (ch !== "'" && ch !== "’") {
    return true;
  }
  return !isApostropheInsideWord(text, index);
};

const findDefinedTermQuoteContent = (
  text: string,
  start: number,
): DefinedTermQuote | null => {
  const min = Math.max(0, start - DEFINED_TERM_LOOKBEHIND);
  let quoteStart = -1;
  for (let i = start - 1; i >= min; i--) {
    const ch = text[i];
    if (ch === "\n") {
      break;
    }
    if (ch && OPENING_QUOTES.has(ch) && isQuoteBoundary(text, i)) {
      quoteStart = i;
      break;
    }
    if (ch && CLOSING_QUOTES.has(ch) && isQuoteBoundary(text, i)) {
      break;
    }
  }
  if (quoteStart === -1) {
    return null;
  }

  const max = Math.min(text.length, quoteStart + 1 + DEFINED_TERM_LOOKAHEAD);
  for (let i = start; i < max; i++) {
    const ch = text[i];
    if (!ch || !CLOSING_QUOTES.has(ch) || !isQuoteBoundary(text, i)) {
      continue;
    }
    const after = text.slice(i + 1, max);
    if (!DEFINED_TERM_CUE_RE.test(after)) {
      return null;
    }
    return {
      content: text.slice(quoteStart + 1, i),
      afterClosingQuote: after,
    };
  }

  return null;
};

const FIRST_WORD_RE = /^\p{L}+/u;
const WORD_RE = /\p{L}+/gu;

const startsWithKnownFirstName = (
  quoteContent: string,
  ctx: PipelineContext,
): boolean => {
  const firstWord = FIRST_WORD_RE.exec(quoteContent.trim())?.[0];
  if (!firstWord) {
    return false;
  }
  const firstNames = new Set(
    getNameCorpusFirstNames(ctx).map((name) => name.toLowerCase()),
  );
  return firstNames.has(firstWord.toLowerCase());
};

const hasPersonRoleDefinition = (
  afterClosingQuote: string,
  ctx: PipelineContext,
): boolean => {
  const roleWords =
    afterClosingQuote
      .replace(DEFINED_TERM_CUE_RE, "")
      .match(WORD_RE)
      ?.slice(0, 8) ?? [];
  if (roleWords.length === 0) {
    return false;
  }

  const genericRoles = ctx.genericRoles ?? EMPTY_GENERIC_ROLES;
  return roleWords.some((word) => genericRoles.has(word.toLowerCase()));
};

const isSuppressibleDefinedTermQuote = (
  text: string,
  start: number,
  ctx: PipelineContext,
): boolean => {
  const definedTermQuote = findDefinedTermQuoteContent(text, start);
  if (definedTermQuote === null) {
    return false;
  }

  const words = definedTermQuote.content.match(WORD_RE) ?? [];

  // A quoted defined term can itself be a real person.
  // Preserve those when the definition points at a role from
  // dictionary data.
  if (
    words.length >= 2 &&
    startsWithKnownFirstName(definedTermQuote.content, ctx) &&
    hasPersonRoleDefinition(definedTermQuote.afterClosingQuote, ctx)
  ) {
    return false;
  }

  return words.length >= 2;
};

const extendPersonName = (
  text: string,
  start: number,
  end: number,
  ctx: PipelineContext,
): { end: number; text: string } => {
  let newEnd = end;

  // Extend forward: skip whitespace, check if next
  // word starts with uppercase
  let pos = newEnd;
  while (pos < text.length) {
    // Skip single whitespace
    if (pos < text.length && text[pos] === " ") {
      const wordStart = pos + 1;
      if (wordStart >= text.length) {
        break;
      }

      const char = text[wordStart] ?? "";
      if (!UPPER_START_RE.test(char)) {
        break;
      }

      // Find end of this word
      let wordEnd = wordStart;
      while (wordEnd < text.length && !/\s/.test(text[wordEnd] ?? "")) {
        wordEnd++;
      }

      // Skip trailing punctuation and typographic closing
      // quotes so stopword checks see the bare word.
      const word = text.slice(wordStart, wordEnd);
      const stripped = word.replace(/[,;.”"’'“»]+$/, "");
      if (stripped.length < 2) {
        break;
      }

      // Do not consult the global allow list here: common
      // words can be legitimate name extensions once a first
      // name has established person context.
      const lower = stripped.toLowerCase();
      if (getStopwords(ctx).has(lower) || getPersonStopwords(ctx).has(lower)) {
        break;
      }

      newEnd = wordStart + stripped.length;
      pos = newEnd;
    } else {
      break;
    }
  }

  return {
    end: newEnd,
    text: text.slice(start, newEnd),
  };
};
