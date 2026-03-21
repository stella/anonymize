import type { Match } from "@stll/text-search";

import {
  getNameCorpusFirstNames,
  getNameCorpusSurnames,
  getNameCorpusTitles,
  initNameCorpus,
} from "./names";
import { resolveCountries } from "../regions";
import { DETECTION_SOURCES } from "../types";
import type { Entity, PipelineConfig } from "../types";
import { loadGenericRoles } from "../filters/false-positives";
import { normalizeForSearch } from "../util/normalize";
import {
  ALL_UPPER_RE,
  UPPER_START_RE,
  isSentenceStart,
} from "../util/text";

/**
 * Try to load the optional @stll/anonymize-data package.
 * Returns null if not installed.
 */
const loadDataModule = async (): Promise<
  typeof import("@stll/anonymize-data") | null
> => {
  try {
    return await import("@stll/anonymize-data");
  } catch {
    return null;
  }
};

export type DenyListConfig = Pick<
  PipelineConfig,
  | "enableDenyList"
  | "denyListCountries"
  | "denyListRegions"
  | "denyListExcludeCategories"
>;

// ── Allow list (lazy-loaded from JSON) ───────────────

let _allowList: ReadonlySet<string> | null = null;
let _allowListPromise:
  | Promise<ReadonlySet<string>>
  | null = null;

const loadAllowList =
  (): Promise<ReadonlySet<string>> => {
    if (_allowListPromise) return _allowListPromise;
    _allowListPromise = (async () => {
      try {
        const mod: {
          default?: { words?: string[] };
        } = await import(
          "@stll/anonymize-data/config/allow-list.json"
        );
        const set: ReadonlySet<string> = new Set(
          mod.default?.words ?? [],
        );
        _allowList = set;
        return set;
      } catch {
        const empty: ReadonlySet<string> = new Set();
        _allowList = empty;
        return empty;
      }
    })();
    return _allowListPromise;
  };

const EMPTY_ALLOW_LIST: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
const getAllowList = (): ReadonlySet<string> =>
  _allowList ?? EMPTY_ALLOW_LIST;

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
const SUPPLEMENTARY_NAME_EXCLUSIONS: ReadonlySet<string> =
  new Set([
    "ana", "ben", "dan", "eden", "ella", "ina", "jo",
    "kai", "lena", "may", "mia", "sam", "sara", "sue",
    "tim", "tom",
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
let _firstNameExclusions: ReadonlySet<string> | null =
  null;
let _exclusionCorpusLen = 0;

const getFirstNameExclusions =
  (): ReadonlySet<string> => {
    const corpus = getNameCorpusFirstNames();
    // Re-build if corpus has been populated since last call
    if (
      _firstNameExclusions &&
      corpus.length === _exclusionCorpusLen
    ) {
      return _firstNameExclusions;
    }
    _exclusionCorpusLen = corpus.length;
    _firstNameExclusions = new Set([
      ...corpus.map((n) => n.toLowerCase()),
      ...SUPPLEMENTARY_NAME_EXCLUSIONS,
    ]);
    return _firstNameExclusions;
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
let _stopwords: ReadonlySet<string> | null = null;
let _stopwordsPromise: Promise<ReadonlySet<string>> | null =
  null;

// INVARIANT: must be called after initNameCorpus() has
// resolved, so getFirstNameExclusions() sees the full
// corpus. buildDenyList() enforces this ordering.
const loadStopwords = (): Promise<ReadonlySet<string>> => {
  if (_stopwordsPromise) return _stopwordsPromise;
  _stopwordsPromise = (async () => {
    try {
      const mod: { default?: string[] } = await import(
        "@stll/anonymize-data/config/stopwords.json"
      );
      const list = (mod.default ?? []).filter(
        (w: string) =>
          !getFirstNameExclusions().has(w),
      );
      const set: ReadonlySet<string> = new Set(list);
      _stopwords = set;
      return set;
    } catch (err) {
      console.warn(
        "[anonymize] Failed to load stopwords.json"
          + " — stopword filtering disabled:",
        err,
      );
      const empty: ReadonlySet<string> = new Set();
      _stopwords = empty;
      return empty;
    }
  })();
  return _stopwordsPromise;
};

const EMPTY_STOPWORDS: ReadonlySet<string> = new Set();

/** Sync accessor — returns empty set before init. */
const getStopwords = (): ReadonlySet<string> =>
  _stopwords ?? EMPTY_STOPWORDS;

// ── Person stopwords (lazy-loaded from JSON) ─────────

let _personStopwords: ReadonlySet<string> | null = null;
let _personStopwordsPromise:
  | Promise<ReadonlySet<string>>
  | null = null;

const loadPersonStopwords =
  (): Promise<ReadonlySet<string>> => {
    if (_personStopwordsPromise) {
      return _personStopwordsPromise;
    }
    _personStopwordsPromise = (async () => {
      try {
        const mod: {
          default?: { words?: string[] };
        } = await import(
          "@stll/anonymize-data/config/person-stopwords.json"
        );
        const set: ReadonlySet<string> = new Set(
          mod.default?.words ?? [],
        );
        _personStopwords = set;
        return set;
      } catch {
        const empty: ReadonlySet<string> = new Set();
        _personStopwords = empty;
        return empty;
      }
    })();
    return _personStopwordsPromise;
  };

const EMPTY_PERSON_STOPWORDS: ReadonlySet<string> =
  new Set();

/** Sync accessor — returns empty set before init. */
const getPersonStopwords = (): ReadonlySet<string> =>
  _personStopwords ?? EMPTY_PERSON_STOPWORDS;

/**
 * Source tag for each pattern in the automaton.
 * "deny-list" = standard deny list entry
 * "first-name" = name corpus first name
 * "surname" = name corpus surname
 * "title" = academic/professional title
 */
type PatternSource =
  | "deny-list"
  | "first-name"
  | "surname"
  | "title";

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
  labels: string[][];
  /** Maps pattern index → original pattern text. */
  originals: string[];
  /** Maps pattern index → source types (plural). */
  sources: PatternSource[][];
};

/**
 * Resolve which dictionaries to load based on country
 * and category filters, load them, and build the deny
 * list data. The returned data provides PatternEntry[]
 * for the unified builder and parallel arrays for
 * post-processing.
 *
 * Requires `@stll/anonymize-data` to be installed.
 * Returns null if the data package is not available.
 */
export const buildDenyList = async (
  config: DenyListConfig,
): Promise<DenyListData | null> => {
  // Pre-load name corpus so getNameCorpus*() accessors
  // and getFirstNameExclusions() are populated before
  // stopwords filtering runs.
  await initNameCorpus();
  // Pre-load all JSON data so sync accessors are
  // populated before processDenyListMatches runs.
  await Promise.all([
    loadStopwords(),
    loadAllowList(),
    loadPersonStopwords(),
    loadGenericRoles(),
  ]);
  const dataModule = await loadDataModule();
  if (!dataModule) {
    return null;
  }

  const allowedCountries = resolveCountries(
    config.denyListRegions,
    config.denyListCountries,
  );

  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded
    ? new Set(excluded)
    : new Set<string>();

  const allIds = [...dataModule.ALL_DICTIONARY_IDS];

  const ids = allIds.filter((id) => {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) {
      return false;
    }

    if (excludeCategories.has(meta.category)) {
      return false;
    }

    if (allowedCountries === null) {
      return true;
    }

    if (meta.country === null) {
      return true;
    }

    return allowedCountries.has(meta.country);
  });

  const patternList: string[] = [];
  const labelList: string[][] = [];
  const sourceList: PatternSource[][] = [];
  // Maps lowercased pattern → index in patternList
  // for accumulating labels from multiple dictionaries
  const patternIndex = new Map<string, number>();

  const results = await Promise.all(
    ids.map(async (id) => {
      const entries =
        await dataModule.loadDictionary(id);
      return { id, entries };
    }),
  );

  const addDenyListEntry = (
    entry: string,
    label: string,
  ) => {
    // Strip | and \ only — these caused the 12K FP
    // bug (| creates empty regex alternation, \ is
    // an escape prefix). Other chars like () [] are
    // kept since they appear in real dictionary
    // entries and are matched literally by AC.
    const normalized = normalizeForSearch(entry)
      .replace(/[|\\]/g, "");
    if (normalized.length === 0) {
      return;
    }
    const lower = normalized.toLowerCase();
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      if (!labelList[existing]!.includes(label)) {
        labelList[existing]!.push(label);
      }
      if (!sourceList[existing]!.includes("deny-list")) {
        sourceList[existing]!.push("deny-list");
      }
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(normalized);
      labelList.push([label]);
      sourceList.push(["deny-list"]);
    }
  };

  for (const { id, entries } of results) {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) {
      continue;
    }
    for (const entry of entries) {
      addDenyListEntry(entry, meta.label);
    }
  }

  // Load city dictionaries dynamically for all
  // allowed countries. Cities cover 230 countries
  // via GeoNames and are loaded separately from
  // the static dictionary registry.
  if (!excludeCategories.has("Places")) {
    const cityCountries =
      allowedCountries !== null
        ? [...allowedCountries]
        : // No country filter — load all. In practice
          // this would be massive, so limit to a
          // reasonable set of common legal jurisdictions.
          [
            "AT", "AU", "BE", "BG", "BR", "CA",
            "CH", "CZ", "DE", "DK", "ES", "FI",
            "FR", "GB", "GR", "HR", "HU", "IE",
            "IT", "LU", "NL", "NO", "NZ", "PL",
            "PT", "RO", "SE", "SI", "SK", "US",
          ];
    const cityEntries =
      await dataModule.loadCityDictionaries(
        cityCountries,
      );
    for (const entry of cityEntries) {
      addDenyListEntry(entry, "address");
    }
  }

  // Add name corpus entries — accumulate labels
  // for entries that already exist from deny-list.
  const addNameEntry = (
    name: string,
    source: PatternSource,
  ) => {
    // Normalize same as deny-list entries so name
    // patterns match against normalizeForSearch(text).
    const normalized = normalizeForSearch(name)
      .replace(/[|\\]/g, "");
    if (normalized.length === 0) {
      return;
    }
    const lower = normalized.toLowerCase();
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      if (!labelList[existing]!.includes("person")) {
        labelList[existing]!.push("person");
      }
      if (!sourceList[existing]!.includes(source)) {
        sourceList[existing]!.push(source);
      }
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(normalized);
      labelList.push(["person"]);
      sourceList.push([source]);
    }
  };

  for (const name of getNameCorpusFirstNames()) {
    addNameEntry(name, "first-name");
  }
  for (const name of getNameCorpusSurnames()) {
    addNameEntry(name, "surname");
  }
  for (const title of getNameCorpusTitles()) {
    const norm = normalizeForSearch(title)
      .replace(/[|\\]/g, "");
    if (norm.length === 0) continue;
    const lower = norm.toLowerCase();
    const existing = patternIndex.get(lower);
    if (existing !== undefined) {
      if (!sourceList[existing]!.includes("title")) {
        sourceList[existing]!.push("title");
      }
    } else {
      patternIndex.set(lower, patternList.length);
      patternList.push(norm);
      labelList.push(["person"]);
      sourceList.push(["title"]);
    }
  }

  if (patternList.length === 0) {
    return null;
  }

  return {
    labels: labelList,
    originals: patternList,
    sources: sourceList,
  };
};

type RawMatch = {
  start: number;
  end: number;
  /** All labels for this pattern (e.g., ["person", "address"]). */
  labels: string[];
  text: string;
  patternIdx: number;
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
): Entity[] => {
  // Pass 1: collect valid matches grouped by pattern
  const matchesByPattern = new Map<
    number,
    RawMatch[]
  >();

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const localIdx = idx - sliceStart;

    const sourceChar = fullText[match.start] ?? "";
    if (!UPPER_START_RE.test(sourceChar)) {
      continue;
    }

    // Use original text for display; normalized was
    // only for the AC search.
    const matchText = fullText.slice(
      match.start,
      match.end,
    );
    const keyword = matchText.toLowerCase();
    if (getStopwords().has(keyword) || getAllowList().has(keyword)) {
      continue;
    }

    // Skip ALL-CAPS tokens (likely acronyms, not PII)
    // unless surrounding context is also all-caps
    if (ALL_UPPER_RE.test(matchText)) {
      continue;
    }

    const labels = data.labels[localIdx];
    if (!labels || labels.length === 0) {
      continue;
    }

    const entry: RawMatch = {
      start: match.start,
      end: match.end,
      labels,
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

  for (const [, matches] of Array.from(
    matchesByPattern,
  )) {
    const first = matches[0];
    if (!first) {
      continue;
    }

    const hasPerson = first.labels.includes("person");
    const nonPersonLabels = first.labels.filter(
      (l) => l !== "person",
    );

    // Person hits go to chain scoring (Pass 2b).
    // Skip words that are valid places/orgs but not
    // person names (months, states, languages).
    if (hasPerson) {
      const keyword = first.text.toLowerCase();
      if (!getPersonStopwords().has(keyword)) {
        for (const m of matches) {
          nameHits.push(m);
        }
      }
    }

    // Emit entities for all non-person labels
    for (const m of matches) {
      for (const label of nonPersonLabels) {
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
      if (
        gap.length > 4 ||
        gap.length === 0 ||
        gap.includes("\n") ||
        gap.includes("\t")
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

    const extended = extendPersonName(
      fullText,
      first.start,
      last.end,
    );

    // Score: chained names get 0.9, single names 0.5
    const score = chain.length >= 2 ? 0.9 : 0.5;

    // Skip standalone single-word names at sentence
    // start (likely not a person name)
    if (
      chain.length === 1 &&
      isSentenceStart(fullText, first.start)
    ) {
      continue;
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

  return results;
};

/**
 * Extend a person name match to include subsequent
 * capitalized words. "Pavel" + " Heřmánek" → "Pavel
 * Heřmánek". Stops at lowercase words, punctuation,
 * or end of text. Also extends backward if preceded
 * by a capitalized word (for "Miroslav Braňka" when
 * only "Braňka" matched).
 */
const extendPersonName = (
  text: string,
  start: number,
  end: number,
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
      while (
        wordEnd < text.length &&
        !/\s/.test(text[wordEnd] ?? "")
      ) {
        wordEnd++;
      }

      // Skip trailing punctuation (commas, etc.)
      const word = text.slice(wordStart, wordEnd);
      const stripped = word.replace(/[,;.]+$/, "");
      if (stripped.length < 2) {
        break;
      }

      // Don't extend into global or person stopwords
      const lower = stripped.toLowerCase();
      if (
        getStopwords().has(lower) ||
        getPersonStopwords().has(lower)
      ) {
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
