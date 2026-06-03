import type { Match } from "@stll/text-search";

import {
  getNameCorpusFirstNames,
  getNameCorpusSurnames,
  getNameCorpusTitles,
  initNameCorpus,
} from "./names";
import { resolveCountries } from "../regions";
import { DETECTION_SOURCES } from "../types";
import type {
  Dictionaries,
  DictionaryMeta,
  Entity,
  PipelineConfig,
} from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";
import { loadGenericRoles } from "../filters/false-positives";
import { normalizeForSearch } from "../util/normalize";
import { ALL_UPPER_RE, UPPER_START_RE } from "../util/text";
import { DASH } from "../util/char-groups";

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
 * Computed lazily after initNameCorpus() has populated
 * the first-name corpus. Re-builds if corpus size changes.
 */
const getFirstNameExclusions = (ctx: PipelineContext): ReadonlySet<string> => {
  const corpus = getNameCorpusFirstNames(ctx);
  // Re-build if corpus has been populated since last call
  if (
    ctx.firstNameExclusions &&
    corpus.length === ctx.firstNameExclusionCorpusLen
  ) {
    return ctx.firstNameExclusions;
  }
  ctx.firstNameExclusionCorpusLen = corpus.length;
  const set: ReadonlySet<string> = new Set([
    ...corpus.map((n) => n.toLowerCase()),
    ...SUPPLEMENTARY_NAME_EXCLUSIONS,
  ]);
  ctx.firstNameExclusions = set;
  return set;
};

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

// INVARIANT: must be called after initNameCorpus() has
// resolved, so getFirstNameExclusions() sees the full
// corpus. buildDenyList() enforces this ordering.
const loadStopwords = (ctx: PipelineContext): Promise<ReadonlySet<string>> => {
  if (ctx.stopwordsPromise) return ctx.stopwordsPromise;
  ctx.stopwordsPromise = (async () => {
    try {
      const mod: { default?: string[] } =
        await import("../data/stopwords.json");
      const list = (mod.default ?? []).filter(
        (w: string) => !getFirstNameExclusions(ctx).has(w),
      );
      const set: ReadonlySet<string> = new Set(list);
      ctx.stopwords = set;
      return set;
    } catch (err) {
      console.warn(
        "[anonymize] Failed to load stopwords.json" +
          " — stopword filtering disabled:",
        err,
      );
      const empty: ReadonlySet<string> = new Set();
      ctx.stopwords = empty;
      return empty;
    }
  })();
  return ctx.stopwordsPromise;
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
      const mod: {
        default?: { words?: string[] };
      } = await import("../data/person-stopwords.json");
      const set: ReadonlySet<string> = new Set(mod.default?.words ?? []);
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

/**
 * Capitalised words that almost never start a person name. When a
 * single-token surname candidate is immediately followed by one of
 * these, the "next-word is uppercase" promotion heuristic would
 * otherwise turn section headings ("Purchase Price↵The Purchaser
 * undertakes…") into spurious person hits. Kept narrow on purpose;
 * the surrounding pipeline still chains real names via the deny-list
 * cascade when both halves are surnames.
 */
const SENTENCE_STARTER_WORDS: ReadonlySet<string> = new Set([
  "The",
  "This",
  "These",
  "Those",
  "An",
  "Any",
  "All",
  "Each",
  "Every",
  "No",
  "Now",
  "Whereas",
  "Whereby",
  "Wherein",
  "Whereof",
  "Notwithstanding",
  "Subject",
  "In",
  "On",
  "At",
  "By",
  "For",
  "If",
  "Upon",
  "Unless",
  "Until",
  "Provided",
  "Pursuant",
  "Such",
]);

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
  // Pre-load name corpus so getNameCorpus*() accessors
  // and getFirstNameExclusions() are populated before
  // stopwords filtering runs.
  await initNameCorpus(ctx, config.dictionaries, config.nameCorpusLanguages);
  // Pre-load all JSON data so sync accessors are
  // populated before processDenyListMatches runs.
  await Promise.all([
    loadStopwords(ctx),
    loadAllowList(ctx),
    loadPersonStopwords(ctx),
    loadAddressStopwords(ctx),
    loadCommonWords(),
    loadStreetTypeRe(),
    loadGenericRoles(ctx),
  ]);
  const commonWords = await loadCommonWords();

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
    return buildNameCorpusOnly(config, ctx);
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
    if (source !== "custom-deny-list" && label !== "address") {
      if (SINGLE_WORD_RE.test(normalized) && commonWords.has(lower)) {
        return;
      }
      if (isShortCuratedNoiseAcronym(normalized)) {
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
    ctx,
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
  ctx: PipelineContext,
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
    ctx,
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
  };
};

/**
 * Append name corpus entries (first names, surnames,
 * titles) to the pattern arrays. Shared between
 * buildDenyList and buildNameCorpusOnly.
 */
const appendNameCorpusEntries = (
  config: DenyListConfig,
  ctx: PipelineContext,
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

  for (const name of getNameCorpusFirstNames(ctx)) {
    addNameEntry(name, "first-name");
  }
  for (const name of getNameCorpusSurnames(ctx)) {
    addNameEntry(name, "surname");
  }
  for (const title of getNameCorpusTitles(ctx)) {
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

/**
 * Ensure all deny-list support data (stopwords, allow
 * list, person stopwords, generic roles) is loaded on
 * the given context. Call this before
 * processDenyListMatches / filterFalsePositives when
 * the search instance was built on a different context
 * (e.g. cachedSearch).
 */
export const ensureDenyListData = async (
  ctx: PipelineContext = defaultContext,
  dictionaries?: Dictionaries,
  nameCorpusLanguages?: readonly string[],
): Promise<void> => {
  // INVARIANT: initNameCorpus must resolve before
  // loadStopwords so first-name exclusions are
  // available when computing the stopword set.
  await initNameCorpus(ctx, dictionaries, nameCorpusLanguages);
  await Promise.all([
    loadStopwords(ctx),
    loadAllowList(ctx),
    loadPersonStopwords(ctx),
    loadAddressStopwords(ctx),
    loadStreetTypeRe(),
    loadGenericRoles(ctx),
  ]);
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

    // Skip the trailing-capitalised-word extension when the
    // chain sits inside a defined-term quote
    // (`"Bond Hedge Transactions"`, `"Blue Sky Laws"`).
    // Legal prose uses curly or straight quotes to introduce
    // capitalised noun phrases that are not personal names;
    // chaining beyond the name corpus inside that bracketed
    // context produces unstable spans like
    // `"Bond Hedge Transactions"`-as-person.
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

    // Single-word deny-list matches are too noisy:
    // "Rate", "Server", "Code" etc. are surnames but
    // also common English words. Only accept single-
    // word matches when the next word is also uppercase
    // (likely a full name: "Alena Zemanová"). Skip
    // sentence-starter articles ("The Purchaser…")
    // which otherwise turn section headings like
    // "Purchase Price↵The Purchaser…" into person hits.
    if (chain.length === 1) {
      const afterEnd = last.end;
      const rest = fullText.slice(afterEnd).trimStart();
      // Require Cap + lowercase: filters out acronyms like
      // "EU", "USA" so "Rady EU" doesn't read as a name.
      const nextIsUpper = rest.length > 1 && /^\p{Lu}\p{Ll}/u.test(rest);
      if (!nextIsUpper) {
        continue;
      }
      // Reject sentence-starter articles ("The Purchaser…")
      // so section headings followed by a sentence don't
      // get promoted to person hits.
      const nextWord = /^\p{L}+/u.exec(rest)?.[0] ?? "";
      if (SENTENCE_STARTER_WORDS.has(nextWord)) {
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
  extendCityDistricts(results, fullText);

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

// Words that must NOT be absorbed into an address span
// when they follow a postal-code + city pattern. Party
// roles, organizational nouns, and common legal terms.
const TRAILING_WORD_EXCLUSIONS: ReadonlySet<string> = new Set([
  // CZ/SK party roles
  "nájemce",
  "pronajímatel",
  "kupující",
  "prodávající",
  "objednatel",
  "zhotovitel",
  "dodavatel",
  "odběratel",
  "věřitel",
  "dlužník",
  "zadavatel",
  "uchazeč",
  "příjemce",
  "plátce",
  // Organizational nouns
  "správa",
  "sekretariát",
  "kancelář",
  "odbor",
  "oddělení",
  "úřad",
  "inspekce",
  "agentura",
  // Legal clause starters
  "článek",
  "smlouva",
  "dodatek",
  "příloha",
  "předmět",
  "podmínky",
  "ustanovení",
]);

const extendCityDistricts = (entities: Entity[], fullText: string): void => {
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
      if (!TRAILING_WORD_EXCLUSIONS.has(candidate)) {
        entity.end += trailingWordM[0].length;
        entity.text = fullText.slice(entity.start, entity.end);
      }
    }
  }
};

/**
 * Extend a person name match to include subsequent
 * capitalized words. "Pavel" + " Heřmánek" → "Pavel
 * Heřmánek". Stops at lowercase words, punctuation,
 * or end of text. Also extends backward if preceded
 * by a capitalized word (for "Miroslav Braňka" when
 * only "Braňka" matched).
 */
/**
 * Defined-term marker: an opening typographic or straight
 * quote enclosing the chain start, AND a closing quote
 * within a short window followed by a
 * definitional cue (`means`, `shall mean`, `shall have
 * the meaning(s)`, `refers to`). Legal documents reserve
 * this construction for defined terms; the contents are
 * not personal names even when individual tokens collide
 * with the name corpus.
 *
 * Plain quotations like `"John Unknown" said ...` do NOT
 * count: there is no definitional cue, so the trailing
 * surname extension is still allowed to absorb `Unknown`.
 */
const OPENING_QUOTES = new Set(['"', "'", "“", "„", "‟", "‘", "‛", "«"]);
const CLOSING_QUOTES = new Set(['"', "'", "”", "’", "»", "“"]);
const DEFINED_TERM_CUE_RE =
  /^[\s,]*(?:means?|shall\s+means?|shall\s+have\s+the\s+meanings?|refers?\s+to|has\s+the\s+meanings?|is\s+defined)\b/iu;
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

  // A quoted defined term can itself be a real person:
  // `"John Smith" shall mean the employee...`. Preserve those
  // when the definition itself points at a legal/business role
  // from dictionary data. Legal terms such as `"Bond Hedge"`
  // stay suppressible even if their first token collides with
  // a given-name corpus entry.
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

      // Skip trailing punctuation (commas, periods,
      // typographic closing quotes). Curly quotes survive
      // normalisation because they often appear inside
      // defined-term clauses (`"Blue Sky Laws"`); strip
      // them so the allow-list / stopword check sees the
      // bare word.
      const word = text.slice(wordStart, wordEnd);
      const stripped = word.replace(/[,;.”"’'“»]+$/, "");
      if (stripped.length < 2) {
        break;
      }

      // Don't extend into stopwords or person stopwords.
      // The global allow list is intentionally NOT consulted
      // here: real surnames such as `Law`, `Tesla`, or
      // `Vote` are common English words and live on the
      // allow list to suppress single-token noise, but they
      // are legitimate name extensions when preceded by a
      // first name in plain prose (`John Law`, `Elon
      // Tesla`). Defined-term contexts (`"Blue Sky Laws"`,
      // `"Bond Hedge Transactions"`) are filtered earlier by
      // `isInsideDefinedTermQuote`, so by the time
      // `extendPersonName` runs we are in ordinary prose and
      // the allow-list block would only swallow real
      // surnames.
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
