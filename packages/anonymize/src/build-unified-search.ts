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
import legalFormRuleWords from "./data/legal-form-rule-words.json";

import { getTextSearch } from "./search-engine";

import {
  isLegalFormsEnabled,
  type CustomRegexPattern,
  type GazetteerEntry,
  type PipelineConfig,
} from "./types";
import { applyPipelineLanguageScope } from "./language-scope";
import type { RegexMeta } from "./detectors/regex";
import type { TriggerRule } from "./types";
import type { DenyListData, DenyListFilterData } from "./detectors/deny-list";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";
import { loadLanguageConfigs } from "./util/lang-loader";

import {
  REGEX_PATTERNS,
  REGEX_META,
  NATIVE_REGEX_VALIDATOR_IDS,
  getCurrencyPatternEntries,
  CURRENCY_PATTERN_META,
  getDateMonthData,
  getDatePatterns,
  getYearWordData,
  getMonetaryData,
  DATE_PATTERN_META,
  getSigningClausePatterns,
  getNativeSigningClausePatterns,
  SIGNING_CLAUSE_META,
  type DateMonthData,
  type YearWordData,
  type MonetaryData,
} from "./detectors/regex";
import {
  buildTriggerPatterns,
  getAddressStopKeywordsSync,
} from "./detectors/triggers";
import {
  buildDenyList,
  buildDenyListFilterData,
  ensureDenyListData,
} from "./detectors/deny-list";
import {
  buildStreetTypePatterns,
  getAddressSeedData,
  type AddressSeedData,
} from "./detectors/address-seeds";
import { buildGazetteerPatterns } from "./detectors/gazetteer";
import { buildCountryPatterns, type CountryData } from "./detectors/countries";
import {
  expandLabelsForHotwordRuleSet,
  loadHotwordRuleSet,
  type HotwordRule,
} from "./filters/hotword-rules";
import {
  getAddressContextData,
  type AddressContextData,
} from "./filters/confidence-boost";
import {
  getClauseNounHeadsSync,
  getConnectorProseHeadsSync,
  getKnownLegalSuffixes,
  getLeadingClauseTrimsSync,
  getLegalRoleHeadsSync,
  getNormalizedInNameLegalFormWordsSync,
  getNormalizedLegalBoundarySuffixesSync,
  getSentenceVerbIndicatorsSync,
  getStructuralSingleCapPrefixesSync,
  warmLegalRoleHeads,
} from "./detectors/legal-forms";

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
  regex_overlap_all?: boolean;
  fuzzy_case_insensitive?: boolean;
  fuzzy_whole_words?: boolean;
  fuzzy_normalize_diacritics?: boolean;
};

export type NativeRegexMatchMeta = {
  label: string;
  score: number;
  source_detail?: string;
  requires_validation?: boolean;
  validator_id?: string;
  validator_input?: string;
  min_byte_length?: number;
};

export type NativeDenyListFilterData = {
  stopwords: string[];
  allow_list: string[];
  person_stopwords: string[];
  person_trailing_nouns: string[];
  address_stopwords: string[];
  address_jurisdiction_prefixes: string[];
  street_types: string[];
  address_component_terms: string[];
  ambiguous_street_type_terms: string[];
  first_names: string[];
  generic_roles: string[];
  number_abbrev_prefixes: string[];
  sentence_starters: string[];
  trailing_address_word_exclusions: string[];
  document_heading_words: string[];
  document_heading_ordinal_markers: string[];
  defined_term_cues: string[];
  signing_place_guards: NativeSigningPlaceGuardData[];
};

export type NativeSigningPlaceGuardData = {
  prefix_phrases: string[];
  suffix_phrases: string[];
};

export type NativeDenyListMatchData = {
  labels?: string[][];
  label_table?: string[];
  label_indices?: number[][];
  custom_labels?: string[][];
  custom_label_indices?: number[][];
  originals: string[];
  sources?: string[][];
  source_table?: string[];
  source_indices?: number[][];
  filters?: NativeDenyListFilterData;
};

export type NativeTriggerStrategy =
  | { type: "to-next-comma"; stop_words?: string[]; max_length?: number }
  | { type: "to-end-of-line" }
  | { type: "n-words"; count: number }
  | { type: "company-id-value" }
  | { type: "address"; max_chars?: number }
  | { type: "match-pattern"; pattern: string; flags?: string };

export type NativeTriggerValidation =
  | { type: "starts-uppercase" }
  | { type: "min-length"; min: number }
  | { type: "max-length"; max: number }
  | { type: "no-digits" }
  | { type: "has-digits" }
  | { type: "matches-pattern"; pattern: string; flags?: string }
  | { type: "valid-id"; validator: string };

export type NativeTriggerRule = {
  trigger: string;
  label: string;
  strategy: NativeTriggerStrategy;
  validations: NativeTriggerValidation[];
  include_trigger: boolean;
};

export type NativeTriggerData = {
  rules: NativeTriggerRule[];
  address_stop_keywords: string[];
  party_position_terms: string[];
  sentence_terminal_currency_terms: string[];
};

export type NativeLegalFormData = {
  suffixes: string[];
  normalized_boundary_suffixes: string[];
  normalized_in_name_words: string[];
  normalized_suffix_words: string[];
  role_heads: string[];
  sentence_verb_indicators: string[];
  clause_noun_heads: string[];
  connector_prose_heads: string[];
  structural_single_cap_prefixes: string[];
  leading_clause_phrases: string[];
  leading_clause_direct_prefixes: string[];
  connector_words: string[];
  and_connector_words: string[];
  in_name_prepositions: string[];
  company_suffix_words: string[];
  comma_gated_direct_prefixes: string[];
};

export type NativeDateData = {
  month_names_by_language: DateMonthData;
  year_words_by_language: YearWordData;
};

export type NativeMonetaryData = MonetaryData;
export type NativeAddressSeedData = AddressSeedData;
export type NativeAddressContextData = AddressContextData;
export type NativeCoreferencePatternData = {
  pattern: string;
  flags: string;
};
export type NativeCoreferenceData = {
  definition_patterns: NativeCoreferencePatternData[];
  role_stop_terms: string[];
  legal_form_aliases: string[];
};
type GenericRolesData = {
  roles: string[];
};
export type NativeGazetteerData = {
  labels: string[];
  is_fuzzy: boolean[];
};

export type NativeHotwordRule = {
  target_labels: string[];
  score_adjustment: number;
  reclassify_to?: string;
  proximity_before: number;
  proximity_after: number;
};

export type NativeHotwordRuleData = {
  rules: NativeHotwordRule[];
  pattern_rule_indices: number[];
};

export type NativePreparedSearchConfig = {
  regex_patterns: NativeSearchPattern[];
  custom_regex_patterns: NativeSearchPattern[];
  literal_patterns: NativeSearchPattern[];
  regex_options: NativeSearchOptions;
  custom_regex_options: NativeSearchOptions;
  literal_options: NativeSearchOptions;
  literal_patterns_from_deny_list_data?: boolean;
  allowed_labels: string[];
  threshold: number;
  confidence_boost: boolean;
  slices: {
    regex: PatternSlice;
    custom_regex: PatternSlice;
    legal_forms?: PatternSlice;
    triggers?: PatternSlice;
    deny_list: PatternSlice;
    street_types?: PatternSlice;
    gazetteer: PatternSlice;
    countries: PatternSlice;
    hotwords?: PatternSlice;
  };
  regex_meta: NativeRegexMatchMeta[];
  custom_regex_meta: NativeRegexMatchMeta[];
  deny_list_data?: NativeDenyListMatchData;
  false_positive_filters?: NativeDenyListFilterData;
  gazetteer_data?: NativeGazetteerData;
  country_data?: CountryData;
  hotword_data?: NativeHotwordRuleData;
  trigger_data?: NativeTriggerData;
  legal_form_data?: NativeLegalFormData;
  address_seed_data?: NativeAddressSeedData;
  address_context_data?: NativeAddressContextData;
  coreference_data?: NativeCoreferenceData;
  date_data?: NativeDateData;
  monetary_data?: NativeMonetaryData;
};

const createAllowedLabelSet = (
  labels: readonly string[],
): ReadonlySet<string> | null => (labels.length > 0 ? new Set(labels) : null);

const labelIsAllowed = (
  label: string,
  allowedLabels: ReadonlySet<string> | null,
): boolean => allowedLabels === null || allowedLabels.has(label);

const sliceContains = (slice: PatternSlice, index: number): boolean =>
  index >= slice.start && index < slice.end;

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

type GazetteerPatternResult = {
  patterns: PatternEntry[];
  data: GazetteerData;
};

type CountryPatternResult = {
  patterns: PatternEntry[];
  data: CountryData;
};

type CoreferenceConfigRow = {
  pattern: string;
  flags: string;
};

type UnifiedSearchSources = {
  allRegex: PatternEntry[];
  regexMeta: RegexMeta[];
  customRegexes: CustomRegexPattern[];
  customRegexMeta: RegexMeta[];
  legalForms: readonly string[];
  triggers: {
    patterns: string[];
    rules: TriggerRule[];
  };
  denyListData: DenyListData | null;
  falsePositiveFilters: DenyListFilterData;
  streetTypes: string[];
  gazResult: GazetteerPatternResult | null;
  countryResult: CountryPatternResult | null;
  nativeLegalFormPatterns: string[];
  nativeLegalFormData: NativeLegalFormData | null;
  nativeDateData: NativeDateData | null;
  nativeMonetaryData: NativeMonetaryData | null;
  nativeAddressSeedData: NativeAddressSeedData | null;
  nativeAddressContextData: NativeAddressContextData | null;
  nativeCoreferenceData: NativeCoreferenceData | null;
  nativeSigningPatterns: readonly string[];
  partyPositionTerms: string[];
  hotwordRules: readonly HotwordRule[];
  nativeCurrencyPatternRange: PatternSlice;
  nativeDatePatternRange: PatternSlice;
  nativeSigningPatternRange: PatternSlice;
  nativeAllowedLabels: readonly string[];
  threshold: number;
  confidenceBoost: boolean;
  slices: UnifiedSearchInstance["slices"];
  literalAllPatterns: PatternEntry[] | string[];
  canUseGlobalWholeWordLiterals: boolean;
  customDenyListNeedsWholeWords: (pattern: string) => boolean;
};

export type NativeStaticSearchBundle = {
  nativeStaticConfig: NativePreparedSearchConfig;
  slices: UnifiedSearchInstance["slices"];
  regexMeta: readonly RegexMeta[];
  customRegexMeta: readonly RegexMeta[];
  denyListData: DenyListData | null;
  falsePositiveFilters: DenyListFilterData;
};

const buildUnifiedSearchSources = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<UnifiedSearchSources> => {
  config = applyPipelineLanguageScope(config);
  const legalFormsEnabled = isLegalFormsEnabled(config);
  const hotwordRules =
    config.enableHotwordRules === true ? await loadHotwordRuleSet() : [];
  const searchLabels =
    config.enableHotwordRules === true
      ? expandLabelsForHotwordRuleSet(config.labels, hotwordRules)
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
    _legalFormWarmup,
    triggers,
    denyListData,
    falsePositiveFilters,
    streetTypes,
    currencyPatterns,
    datePatterns,
    signingPatterns,
    nativeSigningPatterns,
    dateMonthData,
    yearWordData,
    monetaryData,
    addressSeedData,
    addressContextData,
    coreferenceData,
  ] = await Promise.all([
    legalFormsEnabled || config.enableTriggerPhrases || config.enableCoreference
      ? warmLegalRoleHeads()
      : Promise.resolve(),
    config.enableTriggerPhrases
      ? buildTriggerPatterns()
      : Promise.resolve({
          patterns: [] as string[],
          rules: [] as TriggerRule[],
        }),
    config.enableDenyList ? buildDenyList(config, ctx) : Promise.resolve(null),
    (async () => {
      await ensureDenyListData(
        ctx,
        config.dictionaries,
        config.nameCorpusLanguages,
      );
      return buildDenyListFilterData(ctx);
    })(),
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
    config.enableRegex && labelIsAllowed("address", allowedLabels)
      ? getNativeSigningClausePatterns()
      : Promise.resolve([] as string[]),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getDateMonthData()
      : Promise.resolve(null),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getYearWordData()
      : Promise.resolve(null),
    config.enableTriggerPhrases ||
    (config.enableRegex && labelIsAllowed("monetary amount", allowedLabels))
      ? getMonetaryData()
      : Promise.resolve(null),
    labelIsAllowed("address", allowedLabels)
      ? getAddressSeedData()
      : Promise.resolve(null),
    labelIsAllowed("address", allowedLabels)
      ? Promise.resolve(getAddressContextData())
      : Promise.resolve(null),
    config.enableCoreference
      ? buildNativeCoreferenceData()
      : Promise.resolve(null),
  ]);
  // Read but never populated: the legal-form slice in the unified
  // search is permanently empty after the v2 rewrite. Tracking it
  // here as a 0-length slice keeps the downstream slice math
  // (start/end offsets for the regex meta) compatible with code
  // that hasn't migrated to v2-aware indexing yet.
  const legalForms: readonly string[] = [];
  void legalFormsEnabled;
  const nativeLegalFormPatterns = legalFormsEnabled
    ? [...getKnownLegalSuffixes()]
    : [];
  const nativeLegalFormSuffixes =
    legalFormsEnabled || config.enableTriggerPhrases || config.enableCoreference
      ? [...getKnownLegalSuffixes()]
      : [];
  const nativeLegalFormData =
    nativeLegalFormSuffixes.length > 0
      ? {
          suffixes: nativeLegalFormSuffixes,
          normalized_boundary_suffixes: [
            ...getNormalizedLegalBoundarySuffixesSync(),
          ],
          normalized_in_name_words: [
            ...getNormalizedInNameLegalFormWordsSync(),
          ],
          normalized_suffix_words: nativeLegalFormSuffixes
            .map((suffix) => suffix.replaceAll(/[.,\s]/g, "").toLowerCase())
            .filter((suffix) => suffix.length > 0),
          role_heads: [...getLegalRoleHeadsSync()],
          sentence_verb_indicators: [...getSentenceVerbIndicatorsSync()],
          clause_noun_heads: [...getClauseNounHeadsSync()],
          connector_prose_heads: [...getConnectorProseHeadsSync()],
          structural_single_cap_prefixes: [
            ...getStructuralSingleCapPrefixesSync(),
          ],
          leading_clause_phrases: [...getLeadingClauseTrimsSync().phrases],
          leading_clause_direct_prefixes: [
            ...getLeadingClauseTrimsSync().directPrefixes,
          ],
          connector_words: legalFormRuleWords.connectorWords,
          and_connector_words: legalFormRuleWords.andConnectorWords,
          in_name_prepositions: legalFormRuleWords.inNamePrepositions,
          company_suffix_words: legalFormRuleWords.companySuffixWords,
          comma_gated_direct_prefixes:
            legalFormRuleWords.commaGatedDirectPrefixes,
        }
      : null;
  const partyPositionTerms = config.enableTriggerPhrases
    ? [...getLegalRoleHeadsSync()]
    : [];

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
  const nativeCurrencyPatternRange = {
    start: allRegex.length,
    end: allRegex.length + currencyPatterns.length,
  };
  for (const pattern of currencyPatterns) {
    allRegex.push(pattern);
    regexMeta.push(CURRENCY_PATTERN_META);
  }
  const nativeDatePatternRange = {
    start: allRegex.length,
    end: allRegex.length + datePatterns.length,
  };
  for (const pattern of datePatterns) {
    allRegex.push(pattern);
    regexMeta.push(DATE_PATTERN_META);
  }
  const nativeSigningPatternRange = {
    start: allRegex.length,
    end: allRegex.length + signingPatterns.length,
  };
  for (const pattern of signingPatterns) {
    allRegex.push(pattern);
    regexMeta.push(SIGNING_CLAUSE_META);
  }
  const customRegexMeta: RegexMeta[] = customRegexes.map((entry) => ({
    label: entry.label,
    score: entry.score ?? DEFAULT_CUSTOM_REGEX_SCORE,
    sourceDetail: "custom-regex" as const,
  }));
  const nativeDateData =
    dateMonthData === null
      ? null
      : {
          month_names_by_language: dateMonthData,
          year_words_by_language: yearWordData ?? {},
        };
  const nativeMonetaryData = monetaryData;

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
  const hasCustomLiteralBoundaryOverride =
    denyListData?.originals.some(
      (pattern, index) =>
        (denyListData.sources[index] ?? []).includes("custom-deny-list") &&
        !customDenyListNeedsWholeWords(pattern),
    ) ?? false;
  const canUseGlobalWholeWordLiterals =
    !hasCustomLiteralBoundaryOverride && gazResult === null;
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

  return {
    allRegex,
    regexMeta,
    customRegexes,
    customRegexMeta,
    legalForms,
    triggers,
    denyListData,
    falsePositiveFilters,
    streetTypes,
    gazResult,
    countryResult,
    nativeLegalFormPatterns,
    nativeLegalFormData,
    nativeDateData,
    nativeMonetaryData,
    nativeAddressSeedData: addressSeedData,
    nativeAddressContextData: addressContextData,
    nativeCoreferenceData:
      coreferenceData === null
        ? null
        : {
            ...coreferenceData,
            legal_form_aliases: nativeLegalFormSuffixes,
          },
    nativeSigningPatterns,
    partyPositionTerms,
    hotwordRules,
    nativeCurrencyPatternRange,
    nativeDatePatternRange,
    nativeSigningPatternRange,
    nativeAllowedLabels: config.labels,
    threshold: config.threshold,
    confidenceBoost: config.enableConfidenceBoost,
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
    literalAllPatterns,
    canUseGlobalWholeWordLiterals,
    customDenyListNeedsWholeWords,
  };
};

export const buildNativeStaticSearchBundle = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<NativeStaticSearchBundle> => {
  const sources = await buildUnifiedSearchSources(
    config,
    gazetteerEntries,
    ctx,
  );
  return {
    nativeStaticConfig: buildNativeStaticConfig({
      regexPatterns: sources.allRegex,
      regexMeta: sources.regexMeta,
      customRegexes: sources.customRegexes,
      customRegexMeta: sources.customRegexMeta,
      denyListData: sources.denyListData,
      falsePositiveFilters: sources.falsePositiveFilters,
      triggerPatterns: sources.triggers.patterns,
      triggerRules: sources.triggers.rules,
      legalFormPatterns: sources.nativeLegalFormPatterns,
      legalFormData: sources.nativeLegalFormData,
      dateData: sources.nativeDateData,
      monetaryData: sources.nativeMonetaryData,
      addressSeedData: sources.nativeAddressSeedData,
      addressContextData: sources.nativeAddressContextData,
      coreferenceData: sources.nativeCoreferenceData,
      nativeSigningPatterns: sources.nativeSigningPatterns,
      partyPositionTerms: sources.partyPositionTerms,
      hotwordRules: sources.hotwordRules,
      streetTypes: sources.streetTypes,
      omitRegexRanges: [
        sources.nativeCurrencyPatternRange,
        sources.nativeDatePatternRange,
        sources.nativeSigningPatternRange,
      ],
      gazetteerPatterns: sources.gazResult?.patterns ?? [],
      gazetteerData: sources.gazResult?.data ?? null,
      countryPatterns: sources.countryResult?.patterns ?? [],
      countryData: sources.countryResult?.data ?? null,
      canUseGlobalWholeWordLiterals: sources.canUseGlobalWholeWordLiterals,
      customDenyListNeedsWholeWords: sources.customDenyListNeedsWholeWords,
      allowedLabels: sources.nativeAllowedLabels,
      threshold: sources.threshold,
      confidenceBoost: sources.confidenceBoost,
    }),
    slices: sources.slices,
    regexMeta: sources.regexMeta,
    customRegexMeta: sources.customRegexMeta,
    denyListData: sources.denyListData,
    falsePositiveFilters: sources.falsePositiveFilters,
  };
};

export const buildUnifiedSearch = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<UnifiedSearchInstance> => {
  const sources = await buildUnifiedSearchSources(
    config,
    gazetteerEntries,
    ctx,
  );
  const triggerEntries = sources.triggers.patterns.map((p) => ({
    pattern: p,
    literal: true as const,
    caseInsensitive: true,
  }));

  const regexAllPatterns = [
    ...sources.allRegex,
    ...sources.legalForms,
    ...triggerEntries,
  ];

  // TextSearch uses static complexity routing for
  // regex patterns: common regexes share bounded
  // chunks, while high-risk patterns are isolated.
  const tsRegex = new (getTextSearch())(regexAllPatterns);
  const tsCustomRegex = new (getTextSearch())(
    sources.customRegexes.map((entry) => entry.pattern),
    {
      overlapStrategy: "all",
    },
  );

  const tsLiterals =
    sources.literalAllPatterns.length > 0
      ? new (getTextSearch())(sources.literalAllPatterns, {
          ...(sources.canUseGlobalWholeWordLiterals
            ? { allLiteral: true, wholeWords: true }
            : {}),
          caseInsensitive: true,
          overlapStrategy: "all",
        })
      : new (getTextSearch())([]);

  const nativeStaticConfig = buildNativeStaticConfig({
    regexPatterns: sources.allRegex,
    regexMeta: sources.regexMeta,
    customRegexes: sources.customRegexes,
    customRegexMeta: sources.customRegexMeta,
    denyListData: sources.denyListData,
    falsePositiveFilters: sources.falsePositiveFilters,
    triggerPatterns: sources.triggers.patterns,
    triggerRules: sources.triggers.rules,
    legalFormPatterns: sources.nativeLegalFormPatterns,
    legalFormData: sources.nativeLegalFormData,
    dateData: sources.nativeDateData,
    monetaryData: sources.nativeMonetaryData,
    addressSeedData: sources.nativeAddressSeedData,
    addressContextData: sources.nativeAddressContextData,
    coreferenceData: sources.nativeCoreferenceData,
    nativeSigningPatterns: sources.nativeSigningPatterns,
    partyPositionTerms: sources.partyPositionTerms,
    hotwordRules: sources.hotwordRules,
    streetTypes: sources.streetTypes,
    omitRegexRanges: [
      sources.nativeCurrencyPatternRange,
      sources.nativeDatePatternRange,
      sources.nativeSigningPatternRange,
    ],
    gazetteerPatterns: sources.gazResult?.patterns ?? [],
    gazetteerData: sources.gazResult?.data ?? null,
    countryPatterns: sources.countryResult?.patterns ?? [],
    countryData: sources.countryResult?.data ?? null,
    canUseGlobalWholeWordLiterals: sources.canUseGlobalWholeWordLiterals,
    customDenyListNeedsWholeWords: sources.customDenyListNeedsWholeWords,
    allowedLabels: sources.nativeAllowedLabels,
    threshold: sources.threshold,
    confidenceBoost: sources.confidenceBoost,
  });

  return {
    tsRegex,
    tsCustomRegex,
    tsLiterals,
    slices: sources.slices,
    regexMeta: sources.regexMeta,
    customRegexMeta: sources.customRegexMeta,
    triggerRules: sources.triggers.rules,
    denyListData: sources.denyListData,
    gazetteerData: sources.gazResult?.data ?? null,
    countryData: sources.countryResult?.data ?? null,
    nativeStaticConfig,
  };
};

type BuildNativeStaticConfigArgs = {
  regexPatterns: readonly PatternEntry[];
  regexMeta: readonly RegexMeta[];
  customRegexes: readonly { pattern: string }[];
  customRegexMeta: readonly RegexMeta[];
  denyListData: DenyListData | null;
  falsePositiveFilters: DenyListFilterData;
  triggerPatterns: readonly string[];
  triggerRules: readonly TriggerRule[];
  legalFormPatterns: readonly string[];
  legalFormData: NativeLegalFormData | null;
  dateData: NativeDateData | null;
  monetaryData: NativeMonetaryData | null;
  addressSeedData: NativeAddressSeedData | null;
  addressContextData: NativeAddressContextData | null;
  coreferenceData: NativeCoreferenceData | null;
  nativeSigningPatterns: readonly string[];
  partyPositionTerms: readonly string[];
  hotwordRules: readonly HotwordRule[];
  omitRegexRanges?: readonly PatternSlice[];
  streetTypes: readonly string[];
  gazetteerPatterns: readonly PatternEntry[];
  gazetteerData: GazetteerData | null;
  countryPatterns: readonly PatternEntry[];
  countryData: CountryData | null;
  canUseGlobalWholeWordLiterals: boolean;
  customDenyListNeedsWholeWords: (pattern: string) => boolean;
  allowedLabels: readonly string[];
  threshold: number;
  confidenceBoost: boolean;
};

const buildNativeStaticConfig = ({
  regexPatterns,
  regexMeta,
  customRegexes,
  customRegexMeta,
  denyListData,
  falsePositiveFilters,
  triggerPatterns,
  triggerRules,
  legalFormPatterns,
  legalFormData,
  dateData,
  monetaryData,
  addressSeedData,
  addressContextData,
  coreferenceData,
  nativeSigningPatterns,
  partyPositionTerms,
  hotwordRules,
  omitRegexRanges,
  streetTypes,
  gazetteerPatterns,
  gazetteerData,
  countryPatterns,
  countryData,
  canUseGlobalWholeWordLiterals,
  customDenyListNeedsWholeWords,
  allowedLabels,
  threshold,
  confidenceBoost,
}: BuildNativeStaticConfigArgs): NativePreparedSearchConfig => {
  const nativeRegexPatterns: NativeSearchPattern[] = [];
  const nativeRegexMeta: NativeRegexMatchMeta[] = [];
  for (const [index, pattern] of regexPatterns.entries()) {
    if (omitRegexRanges?.some((range) => sliceContains(range, index))) {
      continue;
    }
    const meta = regexMeta[index];
    if (!meta) {
      continue;
    }
    nativeRegexPatterns.push(toNativeRegexPattern(pattern));
    nativeRegexMeta.push(toNativeRegexMeta(meta));
  }
  for (const pattern of nativeSigningPatterns) {
    nativeRegexPatterns.push(toNativeRegexPattern(pattern));
    nativeRegexMeta.push(toNativeRegexMeta(SIGNING_CLAUSE_META));
  }

  const nativeCustomRegexPatterns = customRegexes.map((entry) => ({
    kind: "regex" as const,
    pattern: entry.pattern,
  }));
  const nativeCustomRegexMeta = customRegexMeta.map(toNativeRegexMeta);
  const legalFormNativePatterns = legalFormPatterns.map(
    toNativeLegalFormPattern,
  );
  const triggerNativePatterns = triggerPatterns.map(toNativeTriggerPattern);
  const streetTypeNativePatterns = addressSeedData
    ? streetTypes.map((pattern) =>
        canUseGlobalWholeWordLiterals
          ? toNativeGlobalLiteralPattern(pattern)
          : toNativeDenyListPattern(pattern, true),
      )
    : [];
  const denyListPatternsFromData =
    canUseGlobalWholeWordLiterals && denyListData !== null;

  const denyPatterns =
    denyListData?.originals
      .map((pattern, index) => {
        if (denyListPatternsFromData) {
          return null;
        }
        return toNativeDenyListPattern(
          pattern,
          stringArrayValue(denyListData.sources[index]).includes(
            "custom-deny-list",
          )
            ? customDenyListNeedsWholeWords(pattern)
            : true,
        );
      })
      .filter((pattern): pattern is NativeSearchPattern => pattern !== null) ??
    [];
  const gazetteerNativePatterns = gazetteerPatterns.map(toNativeLiteralPattern);
  const countryNativePatterns = countryPatterns.map((pattern) =>
    canUseGlobalWholeWordLiterals
      ? toNativeGlobalLiteralPattern(patternEntryText(pattern))
      : toNativeLiteralPattern(pattern),
  );
  const nativeHotwordPatterns: NativeSearchPattern[] = [];
  const nativeHotwordPatternRuleIndices: number[] = [];
  for (const [ruleIndex, rule] of hotwordRules.entries()) {
    for (const hotword of rule.hotwords) {
      nativeHotwordPatterns.push(toNativeHotwordPattern(hotword));
      nativeHotwordPatternRuleIndices.push(ruleIndex);
    }
  }

  let literalOffset = 0;
  const denyListPatternCount = denyListPatternsFromData
    ? (denyListData?.originals.length ?? 0)
    : denyPatterns.length;
  const denyListSlice = {
    start: literalOffset,
    end: literalOffset + denyListPatternCount,
  };
  literalOffset = denyListSlice.end;
  const streetTypesSlice = {
    start: literalOffset,
    end: literalOffset + streetTypeNativePatterns.length,
  };
  literalOffset = streetTypesSlice.end;
  const gazetteerSlice = {
    start: literalOffset,
    end: literalOffset + gazetteerNativePatterns.length,
  };
  literalOffset = gazetteerSlice.end;
  const countriesSlice = {
    start: literalOffset,
    end: literalOffset + countryNativePatterns.length,
  };
  literalOffset = countriesSlice.end;
  const hotwordsSlice = {
    start: literalOffset,
    end: literalOffset + nativeHotwordPatterns.length,
  };
  const hasGazetteerFuzzyPatterns =
    gazetteerData?.isFuzzy.some((isFuzzy) => isFuzzy) ?? false;

  const nativeConfig: NativePreparedSearchConfig = {
    regex_patterns: nativeRegexPatterns,
    custom_regex_patterns: nativeCustomRegexPatterns,
    literal_patterns: [
      ...denyPatterns,
      ...streetTypeNativePatterns,
      ...gazetteerNativePatterns,
      ...countryNativePatterns,
      ...nativeHotwordPatterns,
    ],
    regex_options: {
      literal_case_insensitive: true,
      literal_whole_words: false,
      regex_whole_words: false,
    },
    custom_regex_options: {
      regex_whole_words: false,
      regex_overlap_all: true,
    },
    literal_options: {
      literal_case_insensitive: true,
      literal_whole_words: canUseGlobalWholeWordLiterals,
      fuzzy_case_insensitive: true,
      fuzzy_whole_words: !hasGazetteerFuzzyPatterns,
      fuzzy_normalize_diacritics: true,
    },
    literal_patterns_from_deny_list_data: denyListPatternsFromData,
    allowed_labels: [...allowedLabels],
    threshold,
    confidence_boost: confidenceBoost,
    slices: {
      regex: { start: 0, end: nativeRegexPatterns.length },
      custom_regex: { start: 0, end: nativeCustomRegexPatterns.length },
      legal_forms: {
        start: nativeRegexPatterns.length,
        end: nativeRegexPatterns.length + legalFormNativePatterns.length,
      },
      triggers: {
        start: nativeRegexPatterns.length + legalFormNativePatterns.length,
        end:
          nativeRegexPatterns.length +
          legalFormNativePatterns.length +
          triggerNativePatterns.length,
      },
      deny_list: denyListSlice,
      street_types: streetTypesSlice,
      gazetteer: gazetteerSlice,
      countries: countriesSlice,
      hotwords: hotwordsSlice,
    },
    regex_meta: nativeRegexMeta,
    custom_regex_meta: nativeCustomRegexMeta,
  };
  nativeConfig.regex_patterns.push(
    ...legalFormNativePatterns,
    ...triggerNativePatterns,
  );
  if (denyListData) {
    nativeConfig.deny_list_data = toNativeDenyListData(denyListData);
  }
  nativeConfig.false_positive_filters =
    toNativeDenyListFilters(falsePositiveFilters);
  if (gazetteerData) {
    nativeConfig.gazetteer_data = toNativeGazetteerData(gazetteerData);
  }
  if (countryData) {
    nativeConfig.country_data = countryData;
  }
  if (hotwordRules.length > 0) {
    nativeConfig.hotword_data = {
      rules: hotwordRules.map(toNativeHotwordRule),
      pattern_rule_indices: nativeHotwordPatternRuleIndices,
    };
  }
  if (triggerRules.length > 0) {
    nativeConfig.trigger_data = {
      rules: triggerRules.map(toNativeTriggerRule),
      address_stop_keywords: [...getAddressStopKeywordsSync()],
      party_position_terms: [...partyPositionTerms],
      sentence_terminal_currency_terms:
        sentenceTerminalCurrencyTerms(monetaryData),
    };
  }
  if (legalFormData) {
    nativeConfig.legal_form_data = legalFormData;
  }
  if (addressSeedData) {
    nativeConfig.address_seed_data = addressSeedData;
  }
  if (addressContextData) {
    nativeConfig.address_context_data = addressContextData;
  }
  if (coreferenceData) {
    nativeConfig.coreference_data = coreferenceData;
  }
  if (dateData) {
    nativeConfig.date_data = dateData;
  }
  if (monetaryData) {
    nativeConfig.monetary_data = monetaryData;
  }
  return nativeConfig;
};

const toNativeLegalFormPattern = (pattern: string): NativeSearchPattern => ({
  kind: "literal",
  pattern,
});

const toNativeGazetteerData = (data: GazetteerData): NativeGazetteerData => ({
  labels: [...data.labels],
  is_fuzzy: [...data.isFuzzy],
});

const toNativeTriggerPattern = (pattern: string): NativeSearchPattern => ({
  kind: "literal-with-options",
  pattern,
  case_insensitive: true,
});

const toNativeHotwordPattern = (pattern: string): NativeSearchPattern => ({
  kind: "literal-with-options",
  pattern,
  case_insensitive: true,
  whole_words: true,
});

const toNativeHotwordRule = (rule: HotwordRule): NativeHotwordRule => {
  const result: NativeHotwordRule = {
    target_labels: [...rule.targetLabels],
    score_adjustment: rule.scoreAdjustment,
    proximity_before: rule.proximityBefore,
    proximity_after: rule.proximityAfter,
  };
  if (rule.reclassifyTo !== undefined) {
    result.reclassify_to = rule.reclassifyTo;
  }
  return result;
};

const toNativeTriggerRule = (rule: TriggerRule): NativeTriggerRule => ({
  trigger: rule.trigger,
  label: rule.label,
  strategy: toNativeTriggerStrategy(rule.strategy),
  validations: rule.validations.map(toNativeTriggerValidation),
  include_trigger: rule.includeTrigger,
});

const toNativeTriggerStrategy = (
  strategy: TriggerRule["strategy"],
): NativeTriggerStrategy => {
  switch (strategy.type) {
    case "to-next-comma": {
      const result: NativeTriggerStrategy = { type: "to-next-comma" };
      if (strategy.stopWords !== undefined) {
        result.stop_words = [...strategy.stopWords];
      }
      if (strategy.maxLength !== undefined) {
        result.max_length = strategy.maxLength;
      }
      return result;
    }
    case "to-end-of-line":
      return { type: "to-end-of-line" };
    case "n-words":
      return { type: "n-words", count: strategy.count };
    case "company-id-value":
      return { type: "company-id-value" };
    case "address": {
      const result: NativeTriggerStrategy = { type: "address" };
      if (strategy.maxChars !== undefined) {
        result.max_chars = strategy.maxChars;
      }
      return result;
    }
    case "match-pattern": {
      const result: NativeTriggerStrategy = {
        type: "match-pattern",
        pattern: strategy.pattern,
      };
      if (strategy.flags !== undefined) {
        result.flags = strategy.flags;
      }
      return result;
    }
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown trigger strategy: ${String(_exhaustive)}`);
    }
  }
};

const toNativeTriggerValidation = (
  validation: TriggerRule["validations"][number],
): NativeTriggerValidation => {
  switch (validation.type) {
    case "starts-uppercase":
      return { type: "starts-uppercase" };
    case "min-length":
      return { type: "min-length", min: validation.min };
    case "max-length":
      return { type: "max-length", max: validation.max };
    case "no-digits":
      return { type: "no-digits" };
    case "has-digits":
      return { type: "has-digits" };
    case "matches-pattern": {
      const result: NativeTriggerValidation = {
        type: "matches-pattern",
        pattern: validation.re.source,
      };
      if (validation.re.flags.length > 0) {
        result.flags = validation.re.flags;
      }
      return result;
    }
    case "valid-id":
      return {
        type: "valid-id",
        validator: validation.validator,
      };
    default: {
      const _exhaustive: never = validation;
      throw new Error(`Unknown trigger validation: ${String(_exhaustive)}`);
    }
  }
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

const toNativeGlobalLiteralPattern = (
  pattern: string,
): NativeSearchPattern => ({
  kind: "literal",
  pattern,
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
    const isSupportedValidator = nativeSupportsRegexMeta(meta);
    result.requires_validation = true;
    if (isSupportedValidator && meta.validatorId) {
      result.validator_id = meta.validatorId;
    }
    if (isSupportedValidator && meta.validatorInputKind) {
      result.validator_input = meta.validatorInputKind;
    }
  }
  if (meta.minByteLength !== undefined) {
    result.min_byte_length = meta.minByteLength;
  }
  return result;
};

const nativeSupportsRegexMeta = (meta: RegexMeta): boolean => {
  if (!meta.validator) {
    return true;
  }
  return (
    meta.validatorId !== undefined &&
    NATIVE_REGEX_VALIDATOR_IDS.has(meta.validatorId) &&
    (meta.validatorInputKind === undefined ||
      meta.validatorInputKind === "digits-only")
  );
};

const toNativeDenyListData = (data: DenyListData): NativeDenyListMatchData => {
  const labelEncoder = createStringGroupEncoder();
  const sourceEncoder = createStringGroupEncoder();
  const result: NativeDenyListMatchData = {
    label_table: labelEncoder.table,
    label_indices: data.labels.map(labelEncoder.encode),
    originals: data.originals,
    source_table: sourceEncoder.table,
    source_indices: data.sources.map(sourceEncoder.encode),
    filters: toNativeDenyListFilters(data.filters),
  };
  if (data.customLabels.length > 0) {
    const customLabelIndices = data.originals.map((_, index) =>
      labelEncoder.encode(data.customLabels[index]),
    );
    if (customLabelIndices.some((indices) => indices.length > 0)) {
      result.custom_label_indices = customLabelIndices;
    }
  }
  return result;
};

const sentenceTerminalCurrencyTerms = (
  monetaryData: NativeMonetaryData | null,
): string[] => {
  if (monetaryData === null) {
    return [];
  }
  return [
    ...new Set(
      [
        ...monetaryData.currencies.codes,
        ...monetaryData.currencies.symbols,
        ...monetaryData.currencies.local_names,
      ].filter((term) => term.length > 0),
    ),
  ].toSorted();
};

const buildNativeCoreferenceData = async (): Promise<NativeCoreferenceData> => {
  const roleModule = await import("./data/generic-roles.json");
  const roleData = (roleModule.default ?? roleModule) as GenericRolesData;
  const configs = await loadLanguageConfigs<readonly CoreferenceConfigRow[]>(
    "coreference",
    (mod) => {
      const moduleValue = mod as {
        default?: readonly CoreferenceConfigRow[];
      };
      return moduleValue.default ?? (mod as readonly CoreferenceConfigRow[]);
    },
  );
  const definitionPatterns: NativeCoreferencePatternData[] = [];
  for (const rows of configs) {
    for (const row of rows) {
      definitionPatterns.push({
        pattern: row.pattern,
        flags: row.flags,
      });
    }
  }

  return {
    definition_patterns: definitionPatterns,
    role_stop_terms: roleData.roles,
    legal_form_aliases: [],
  };
};

const createStringGroupEncoder = (): {
  table: string[];
  encode: (values: string | readonly string[] | undefined) => number[];
} => {
  const table: string[] = [];
  const indexes = new Map<string, number>();
  const encodeValue = (value: string): number => {
    const existing = indexes.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = table.length;
    table.push(value);
    indexes.set(value, index);
    return index;
  };
  return {
    table,
    encode: (values) => {
      if (values === undefined) {
        return [];
      }
      if (typeof values === "string") {
        return [encodeValue(values)];
      }
      const encoded: number[] = [];
      for (const value of values) {
        encoded.push(encodeValue(value));
      }
      return encoded;
    },
  };
};

const toNativeDenyListFilters = (
  filters: DenyListData["filters"],
): NativeDenyListFilterData => ({
  stopwords: filters.stopwords,
  allow_list: filters.allowList,
  person_stopwords: filters.personStopwords,
  person_trailing_nouns: filters.personTrailingNouns,
  address_stopwords: filters.addressStopwords,
  address_jurisdiction_prefixes: filters.addressJurisdictionPrefixes,
  street_types: filters.streetTypes,
  address_component_terms: filters.addressComponentTerms,
  ambiguous_street_type_terms: filters.ambiguousStreetTypeTerms,
  first_names: filters.firstNames,
  generic_roles: filters.genericRoles,
  number_abbrev_prefixes: filters.numberAbbrevPrefixes,
  sentence_starters: filters.sentenceStarters,
  trailing_address_word_exclusions: filters.trailingAddressWordExclusions,
  document_heading_words: filters.documentHeadingWords,
  document_heading_ordinal_markers: filters.documentHeadingOrdinalMarkers,
  defined_term_cues: filters.definedTermCues,
  signing_place_guards: filters.signingPlaceGuards.map((entry) => ({
    prefix_phrases: entry.prefixPhrases,
    suffix_phrases: entry.suffixPhrases,
  })),
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
