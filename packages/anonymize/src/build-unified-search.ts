/**
 * Build the unified search instances from all
 * detector pattern sources.
 *
 * Two TextSearch instances (not one) to avoid
 * 200K per-pattern object allocations:
 * 1. regex + triggers + legal-forms (mixed, ~140
 *    patterns, caseInsensitive for trigger AC)
 * 2. deny-list + street-types + gazetteer
 *    (caseInsensitive, overlap "all";
 *    deny-list/street-type use per-pattern
 *    wholeWords: true; gazetteer exact use
 *    wholeWords: false; gazetteer fuzzy use
 *    distance: 2 via @stll/fuzzy-search)
 *
 * All patterns are PatternEntry objects with
 * per-pattern literal/wholeWords settings.
 */

import type { PatternEntry, TextSearch } from "@stll/text-search";

import { getTextSearch } from "./search-engine";

import {
  isLegalFormsEnabled,
  type GazetteerEntry,
  type PipelineConfig,
} from "./types";
import type { RegexMeta } from "./detectors/regex";
import type { TriggerRule } from "./types";
import type { DenyListData } from "./detectors/deny-list";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";

import {
  REGEX_PATTERNS,
  REGEX_META,
  getCurrencyPatternEntries,
  CURRENCY_PATTERN_META,
  getDatePatterns,
  DATE_PATTERN_META,
  getSigningClausePatterns,
  SIGNING_CLAUSE_META,
} from "./detectors/regex";
import { buildTriggerPatterns } from "./detectors/triggers";
import { buildDenyList } from "./detectors/deny-list";
import { buildStreetTypePatterns } from "./detectors/address-seeds";
import { buildGazetteerPatterns } from "./detectors/gazetteer";
import { buildCountryPatterns, type CountryData } from "./detectors/countries";
import { expandLabelsForHotwordRules } from "./filters/hotword-rules";

const DEFAULT_CUSTOM_REGEX_SCORE = 0.9;
const ALNUM_RE = /[\p{L}\p{N}]/u;

type PatternSlice = {
  start: number;
  end: number;
};

type NativeSearchPatternKind =
  | "literal"
  | "literal-with-options"
  | "regex"
  | "fuzzy";

export type NativeSearchPattern = {
  kind: NativeSearchPatternKind;
  pattern: string;
  distance?: number;
  case_insensitive?: boolean;
  whole_words?: boolean;
  lazy?: boolean;
  prefilter_any?: string[];
  prefilter_case_insensitive?: boolean;
  prefilter_regex?: string;
};

export type NativeSearchOptions = {
  literal_case_insensitive?: boolean;
  literal_whole_words?: boolean;
  regex_whole_words?: boolean;
  fuzzy_case_insensitive?: boolean;
  fuzzy_whole_words?: boolean;
  fuzzy_normalize_diacritics?: boolean;
};

export type NativeRegexMatchMeta = {
  label: string;
  score: number;
  source_detail?: string;
  requires_validation?: boolean;
  min_byte_length?: number;
};

export type NativeDenyListFilterData = {
  stopwords: string[];
  allow_list: string[];
  person_stopwords: string[];
  address_stopwords: string[];
  street_types: string[];
  first_names: string[];
  generic_roles: string[];
  sentence_starters: string[];
  trailing_address_word_exclusions: string[];
  defined_term_cues: string[];
};

export type NativeDenyListMatchData = {
  labels: string[][];
  custom_labels: string[][];
  originals: string[];
  sources: string[][];
  filters?: NativeDenyListFilterData;
};

export type NativePreparedSearchConfig = {
  regex_patterns: NativeSearchPattern[];
  custom_regex_patterns: NativeSearchPattern[];
  literal_patterns: NativeSearchPattern[];
  regex_options: NativeSearchOptions;
  custom_regex_options: NativeSearchOptions;
  literal_options: NativeSearchOptions;
  slices: {
    regex: PatternSlice;
    custom_regex: PatternSlice;
    legal_forms?: PatternSlice;
    triggers?: PatternSlice;
    deny_list: PatternSlice;
    street_types?: PatternSlice;
    gazetteer: PatternSlice;
    countries: PatternSlice;
  };
  regex_meta: NativeRegexMatchMeta[];
  custom_regex_meta: NativeRegexMatchMeta[];
  deny_list_data?: NativeDenyListMatchData;
  gazetteer_data?: GazetteerData;
  country_data?: CountryData;
};

const createAllowedLabelSet = (
  labels: readonly string[],
): ReadonlySet<string> | null => (labels.length > 0 ? new Set(labels) : null);

const labelIsAllowed = (
  label: string,
  allowedLabels: ReadonlySet<string> | null,
): boolean => allowedLabels === null || allowedLabels.has(label);

export type GazetteerData = {
  /** Maps local pattern index to entry label. */
  labels: string[];
  /**
   * Whether each pattern is fuzzy (distance > 0).
   * Used by the post-processor to assign scores.
   */
  isFuzzy: boolean[];
};

export type UnifiedSearchInstance = {
  /** Regex + triggers + legal-forms. */
  tsRegex: TextSearch;
  /** Caller-owned custom regexes, isolated for overlap preservation. */
  tsCustomRegex: TextSearch;
  /** Deny-list + street-types + gazetteer. */
  tsLiterals: TextSearch;
  slices: {
    regex: PatternSlice;
    customRegex: PatternSlice;
    legalForms: PatternSlice;
    triggers: PatternSlice;
    denyList: PatternSlice;
    streetTypes: PatternSlice;
    gazetteer: PatternSlice;
    countries: PatternSlice;
  };
  regexMeta: readonly RegexMeta[];
  customRegexMeta: readonly RegexMeta[];
  triggerRules: readonly TriggerRule[];
  denyListData: DenyListData | null;
  gazetteerData: GazetteerData | null;
  countryData: CountryData | null;
  nativeStaticConfig: NativePreparedSearchConfig;
};

export const buildUnifiedSearch = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<UnifiedSearchInstance> => {
  const legalFormsEnabled = isLegalFormsEnabled(config);
  const searchLabels =
    config.enableHotwordRules === true
      ? expandLabelsForHotwordRules(config.labels)
      : config.labels;
  const allowedLabels = createAllowedLabelSet(searchLabels);
  const customRegexes = config.enableRegex
    ? (config.customRegexes ?? []).filter((entry) =>
        labelIsAllowed(entry.label, allowedLabels),
      )
    : [];
  // Legal-form detection lives in `detectors/legal-forms-v2.ts`
  // as an AC suffix pass + TS-side validator; the unified search
  // no longer carries legal-form regex patterns. `legalFormsEnabled`
  // still gates whether the v2 detector runs in the pipeline, but
  // its pattern slice is always empty.
  const [
    triggers,
    denyListData,
    streetTypes,
    currencyPatterns,
    datePatterns,
    signingPatterns,
  ] = await Promise.all([
    config.enableTriggerPhrases
      ? buildTriggerPatterns()
      : Promise.resolve({
          patterns: [] as string[],
          rules: [] as TriggerRule[],
        }),
    config.enableDenyList ? buildDenyList(config, ctx) : Promise.resolve(null),
    buildStreetTypePatterns(),
    config.enableRegex && labelIsAllowed("monetary amount", allowedLabels)
      ? getCurrencyPatternEntries()
      : Promise.resolve([] as PatternEntry[]),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getDatePatterns()
      : Promise.resolve([] as string[]),
    config.enableRegex && labelIsAllowed("address", allowedLabels)
      ? getSigningClausePatterns()
      : Promise.resolve([] as string[]),
  ]);
  // Read but never populated: the legal-form slice in the unified
  // search is permanently empty after the v2 rewrite. Tracking it
  // here as a 0-length slice keeps the downstream slice math
  // (start/end offsets for the regex meta) compatible with code
  // that hasn't migrated to v2-aware indexing yet.
  const legalForms: readonly string[] = [];
  void legalFormsEnabled;

  // ── Instance 1: regex + triggers + legal-forms ──
  // Trigger patterns are lowercased strings with
  // caseInsensitive on the AC. Regex patterns have
  // their own (?i) flags (caseInsensitive on AC
  // is ignored for regex since they route to
  // RegexSet). Legal-form patterns are regex too.
  //
  // Currency patterns (from currencies.json) are
  // appended after the static regex patterns; their
  // meta is spliced into regexMeta at the same offset.
  const allRegex: PatternEntry[] = [];
  const regexMeta: RegexMeta[] = [];
  if (config.enableRegex) {
    for (const [index, pattern] of REGEX_PATTERNS.entries()) {
      const meta = REGEX_META[index];
      if (!meta || !labelIsAllowed(meta.label, allowedLabels)) {
        continue;
      }
      allRegex.push(pattern);
      regexMeta.push(meta);
    }
  }
  for (const pattern of currencyPatterns) {
    allRegex.push(pattern);
    regexMeta.push(CURRENCY_PATTERN_META);
  }
  for (const pattern of datePatterns) {
    allRegex.push(pattern);
    regexMeta.push(DATE_PATTERN_META);
  }
  for (const pattern of signingPatterns) {
    allRegex.push(pattern);
    regexMeta.push(SIGNING_CLAUSE_META);
  }
  const customRegexMeta: RegexMeta[] = customRegexes.map((entry) => ({
    label: entry.label,
    score: entry.score ?? DEFAULT_CUSTOM_REGEX_SCORE,
    sourceDetail: "custom-regex" as const,
  }));

  let offset = 0;

  const regexSlice = {
    start: offset,
    end: offset + allRegex.length,
  };
  offset = regexSlice.end;

  const customRegexSlice = {
    start: 0,
    end: customRegexes.length,
  };

  const legalFormsSlice = {
    start: offset,
    end: offset + legalForms.length,
  };
  offset = legalFormsSlice.end;

  const triggersSlice = {
    start: offset,
    end: offset + triggers.patterns.length,
  };

  // Trigger patterns need caseInsensitive on AC
  // (only ~120 objects, not 200K). Regex/legal-form
  // patterns are bare strings (auto-classified).
  const triggerEntries = triggers.patterns.map((p) => ({
    pattern: p,
    literal: true as const,
    caseInsensitive: true,
  }));

  const regexAllPatterns = [...allRegex, ...legalForms, ...triggerEntries];

  // TextSearch uses static complexity routing for
  // regex patterns: common regexes share bounded
  // chunks, while high-risk patterns are isolated.
  const tsRegex = new (getTextSearch())(regexAllPatterns);
  const tsCustomRegex = new (getTextSearch())(
    customRegexes.map((entry) => entry.pattern),
    {
      overlapStrategy: "all",
    },
  );

  // ── Instance 2: deny-list + street-types + gaz ──
  // Deny-list and street-type patterns are plain
  // strings (allLiteral). Gazetteer adds exact
  // literals plus fuzzy PatternEntry objects for
  // terms >= 4 chars.
  offset = 0;

  const denyListOriginals = denyListData?.originals ?? [];
  const denyListSlice = {
    start: offset,
    end: offset + denyListOriginals.length,
  };
  offset = denyListSlice.end;

  const streetTypesSlice = {
    start: offset,
    end: offset + streetTypes.length,
  };
  offset = streetTypesSlice.end;

  // Gazetteer patterns (exact + fuzzy)
  const gazResult =
    config.enableGazetteer && gazetteerEntries.length > 0
      ? buildGazetteerPatterns(gazetteerEntries)
      : null;

  const gazetteerSlice = {
    start: offset,
    end: offset + (gazResult?.patterns.length ?? 0),
  };
  offset = gazetteerSlice.end;

  // Country patterns: ISO 3166-1 names, curated aliases,
  // alpha-3 codes. Literal + case-insensitive + whole-word.
  const countryResult =
    config.enableCountries === false ||
    !labelIsAllowed("country", allowedLabels)
      ? null
      : buildCountryPatterns();

  const countriesSlice = {
    start: offset,
    end: offset + (countryResult?.patterns.length ?? 0),
  };

  // Build the combined pattern array.
  // Deny-list and street-type patterns use
  // per-pattern wholeWords: true (they are
  // known tokens). Gazetteer exact patterns
  // already set wholeWords: false in
  // buildGazetteerPatterns. The global
  // wholeWords is false so fuzzy patterns
  // (which don't support per-pattern override)
  // match without word-boundary constraints.
  const wrapWholeWord = (s: string, wholeWords: boolean): PatternEntry => ({
    pattern: s,
    literal: true as const,
    wholeWords,
  });
  const customDenyListNeedsWholeWords = (pattern: string): boolean => {
    const first = pattern.at(0) ?? "";
    const last = pattern.at(-1) ?? "";
    return ALNUM_RE.test(first) && ALNUM_RE.test(last);
  };
  const literalPatternText = (entry: PatternEntry): string => {
    if (typeof entry === "string") return entry;
    if (entry instanceof RegExp) {
      throw new Error("Expected literal country pattern, got RegExp");
    }
    if (entry.pattern instanceof RegExp) {
      throw new Error("Expected literal country pattern, got RegExp entry");
    }
    return entry.pattern;
  };
  const hasCustomDenyListPatterns =
    denyListData?.sources.some((sources) =>
      sources.includes("custom-deny-list"),
    ) ?? false;
  const canUseGlobalWholeWordLiterals =
    !hasCustomDenyListPatterns && gazResult === null;
  const literalAllPatterns: PatternEntry[] | string[] =
    canUseGlobalWholeWordLiterals
      ? [
          ...denyListOriginals,
          ...streetTypes,
          ...(countryResult?.patterns.map(literalPatternText) ?? []),
        ]
      : [
          ...denyListOriginals.map((pattern, index) =>
            wrapWholeWord(
              pattern,
              (denyListData?.sources[index] ?? []).includes("custom-deny-list")
                ? customDenyListNeedsWholeWords(pattern)
                : true,
            ),
          ),
          ...streetTypes.map((pattern) => wrapWholeWord(pattern, true)),
          ...(gazResult?.patterns ?? []),
          ...(countryResult?.patterns ?? []),
        ];

  const tsLiterals =
    literalAllPatterns.length > 0
      ? new (getTextSearch())(literalAllPatterns, {
          ...(canUseGlobalWholeWordLiterals
            ? { allLiteral: true, wholeWords: true }
            : {}),
          caseInsensitive: true,
          overlapStrategy: "all",
        })
      : new (getTextSearch())([]);

  const nativeStaticConfig = buildNativeStaticConfig({
    regexPatterns: allRegex,
    regexMeta,
    customRegexes,
    customRegexMeta,
    denyListData,
    gazetteerPatterns: gazResult?.patterns ?? [],
    gazetteerData: gazResult?.data ?? null,
    countryPatterns: countryResult?.patterns ?? [],
    countryData: countryResult?.data ?? null,
    customDenyListNeedsWholeWords,
  });

  return {
    tsRegex,
    tsCustomRegex,
    tsLiterals,
    slices: {
      regex: regexSlice,
      customRegex: customRegexSlice,
      legalForms: legalFormsSlice,
      triggers: triggersSlice,
      denyList: denyListSlice,
      streetTypes: streetTypesSlice,
      gazetteer: gazetteerSlice,
      countries: countriesSlice,
    },
    regexMeta,
    customRegexMeta,
    triggerRules: triggers.rules,
    denyListData,
    gazetteerData: gazResult?.data ?? null,
    countryData: countryResult?.data ?? null,
    nativeStaticConfig,
  };
};

type BuildNativeStaticConfigArgs = {
  regexPatterns: readonly PatternEntry[];
  regexMeta: readonly RegexMeta[];
  customRegexes: readonly { pattern: string }[];
  customRegexMeta: readonly RegexMeta[];
  denyListData: DenyListData | null;
  gazetteerPatterns: readonly PatternEntry[];
  gazetteerData: GazetteerData | null;
  countryPatterns: readonly PatternEntry[];
  countryData: CountryData | null;
  customDenyListNeedsWholeWords: (pattern: string) => boolean;
};

const buildNativeStaticConfig = ({
  regexPatterns,
  regexMeta,
  customRegexes,
  customRegexMeta,
  denyListData,
  gazetteerPatterns,
  gazetteerData,
  countryPatterns,
  countryData,
  customDenyListNeedsWholeWords,
}: BuildNativeStaticConfigArgs): NativePreparedSearchConfig => {
  const nativeRegexPatterns: NativeSearchPattern[] = [];
  const nativeRegexMeta: NativeRegexMatchMeta[] = [];
  for (const [index, pattern] of regexPatterns.entries()) {
    const meta = regexMeta[index];
    if (!meta || meta.validator) {
      continue;
    }
    nativeRegexPatterns.push(toNativeRegexPattern(pattern));
    nativeRegexMeta.push(toNativeRegexMeta(meta));
  }

  const nativeCustomRegexPatterns = customRegexes.map((entry) => ({
    kind: "regex" as const,
    pattern: entry.pattern,
  }));
  const nativeCustomRegexMeta = customRegexMeta.map(toNativeRegexMeta);

  const denyPatterns =
    denyListData?.originals.map((pattern, index) =>
      toNativeDenyListPattern(
        pattern,
        stringArrayValue(denyListData.sources[index]).includes(
          "custom-deny-list",
        )
          ? customDenyListNeedsWholeWords(pattern)
          : true,
      ),
    ) ?? [];
  const gazetteerNativePatterns = gazetteerPatterns.map(toNativeLiteralPattern);
  const countryNativePatterns = countryPatterns.map(toNativeLiteralPattern);

  let literalOffset = 0;
  const denyListSlice = {
    start: literalOffset,
    end: literalOffset + denyPatterns.length,
  };
  literalOffset = denyListSlice.end;
  const gazetteerSlice = {
    start: literalOffset,
    end: literalOffset + gazetteerNativePatterns.length,
  };
  literalOffset = gazetteerSlice.end;
  const countriesSlice = {
    start: literalOffset,
    end: literalOffset + countryNativePatterns.length,
  };

  const nativeConfig: NativePreparedSearchConfig = {
    regex_patterns: nativeRegexPatterns,
    custom_regex_patterns: nativeCustomRegexPatterns,
    literal_patterns: [
      ...denyPatterns,
      ...gazetteerNativePatterns,
      ...countryNativePatterns,
    ],
    regex_options: { regex_whole_words: false },
    custom_regex_options: { regex_whole_words: false },
    literal_options: {
      literal_case_insensitive: true,
      literal_whole_words: false,
      fuzzy_case_insensitive: true,
      fuzzy_whole_words: true,
      fuzzy_normalize_diacritics: true,
    },
    slices: {
      regex: { start: 0, end: nativeRegexPatterns.length },
      custom_regex: { start: 0, end: nativeCustomRegexPatterns.length },
      legal_forms: { start: 0, end: 0 },
      triggers: { start: 0, end: 0 },
      deny_list: denyListSlice,
      street_types: { start: 0, end: 0 },
      gazetteer: gazetteerSlice,
      countries: countriesSlice,
    },
    regex_meta: nativeRegexMeta,
    custom_regex_meta: nativeCustomRegexMeta,
  };
  if (denyListData) {
    nativeConfig.deny_list_data = toNativeDenyListData(denyListData);
  }
  if (gazetteerData) {
    nativeConfig.gazetteer_data = gazetteerData;
  }
  if (countryData) {
    nativeConfig.country_data = countryData;
  }
  return nativeConfig;
};

const toNativeDenyListPattern = (
  pattern: string,
  wholeWords: boolean,
): NativeSearchPattern => ({
  kind: "literal-with-options",
  pattern,
  case_insensitive: true,
  whole_words: wholeWords,
});

const toNativeRegexPattern = (entry: PatternEntry): NativeSearchPattern => {
  const pattern: NativeSearchPattern = {
    kind: "regex",
    pattern: patternEntryText(entry),
  };
  if (
    typeof entry === "string" ||
    entry instanceof RegExp ||
    entry.pattern instanceof RegExp
  ) {
    return pattern;
  }

  const regexEntry = entry as {
    lazy?: boolean;
    prefilterAny?: readonly string[];
    prefilterCaseInsensitive?: boolean;
    prefilterRegex?: RegExp;
  };
  if (regexEntry.lazy !== undefined) {
    pattern.lazy = regexEntry.lazy;
  }
  if (regexEntry.prefilterAny !== undefined) {
    pattern.prefilter_any = [...regexEntry.prefilterAny];
  }
  if (regexEntry.prefilterCaseInsensitive !== undefined) {
    pattern.prefilter_case_insensitive = regexEntry.prefilterCaseInsensitive;
  }
  if (regexEntry.prefilterRegex !== undefined) {
    pattern.prefilter_regex = toNativeRegexSource(regexEntry.prefilterRegex);
  }
  return pattern;
};

const toNativeRegexSource = (regex: RegExp): string =>
  regex.ignoreCase ? `(?i:${regex.source})` : regex.source;

const toNativeLiteralPattern = (entry: PatternEntry): NativeSearchPattern => {
  if (typeof entry === "string") {
    return { kind: "literal", pattern: entry };
  }
  if (entry instanceof RegExp) {
    throw new Error("Native static config does not accept RegExp objects");
  }
  if (entry.pattern instanceof RegExp) {
    throw new Error("Native static config does not accept RegExp entries");
  }
  if ("distance" in entry) {
    const pattern: NativeSearchPattern = {
      kind: "fuzzy",
      pattern: entry.pattern,
    };
    if (entry.distance !== "auto") {
      pattern.distance = entry.distance;
    }
    return pattern;
  }
  if (entry.literal === true) {
    const pattern: NativeSearchPattern = {
      kind: "literal-with-options",
      pattern: entry.pattern,
    };
    if (entry.caseInsensitive !== undefined) {
      pattern.case_insensitive = entry.caseInsensitive;
    }
    if (entry.wholeWords !== undefined) {
      pattern.whole_words = entry.wholeWords;
    }
    return pattern;
  }
  return { kind: "regex", pattern: entry.pattern };
};

const patternEntryText = (entry: PatternEntry): string => {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry instanceof RegExp) {
    return entry.source;
  }
  if (entry.pattern instanceof RegExp) {
    return entry.pattern.source;
  }
  return entry.pattern;
};

const toNativeRegexMeta = (meta: RegexMeta): NativeRegexMatchMeta => {
  const result: NativeRegexMatchMeta = {
    label: meta.label,
    score: meta.score,
  };
  if (meta.sourceDetail) {
    result.source_detail = meta.sourceDetail;
  }
  if (meta.validator) {
    result.requires_validation = true;
  }
  if (meta.minByteLength !== undefined) {
    result.min_byte_length = meta.minByteLength;
  }
  return result;
};

const toNativeDenyListData = (data: DenyListData): NativeDenyListMatchData => ({
  labels: data.labels.map(stringArrayValue),
  custom_labels: data.originals.map((_, index) =>
    stringArrayValue(data.customLabels[index]),
  ),
  originals: data.originals,
  sources: data.sources.map(stringArrayValue),
  filters: toNativeDenyListFilters(data.filters),
});

const toNativeDenyListFilters = (
  filters: DenyListData["filters"],
): NativeDenyListFilterData => ({
  stopwords: filters.stopwords,
  allow_list: filters.allowList,
  person_stopwords: filters.personStopwords,
  address_stopwords: filters.addressStopwords,
  street_types: filters.streetTypes,
  first_names: filters.firstNames,
  generic_roles: filters.genericRoles,
  sentence_starters: filters.sentenceStarters,
  trailing_address_word_exclusions: filters.trailingAddressWordExclusions,
  defined_term_cues: filters.definedTermCues,
});

const stringArrayValue = (
  value: string | readonly string[] | undefined,
): string[] => {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return [...value];
};
