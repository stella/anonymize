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
import nameCorpusCjk from "./data/name-corpus-cjk.json";
import nameCorpusParticles from "./data/name-corpus-particles.json";
import organizationIndicators from "./data/organization-indicators.json";
import signatureDetection from "./data/signature-detection.json";
import triggerSupport from "./data/trigger-support.json";

import { getTextSearch } from "./search-engine";

import {
  isLegalFormsEnabled,
  type CustomRegexPattern,
  type GazetteerEntry,
  type PipelineConfig,
} from "./types";
import {
  applyPipelineLanguageScope,
  configuredContentLanguages,
} from "./language-scope";
import type { RegexMeta } from "./detectors/regex";
import type { TriggerRule } from "./types";
import type { DenyListData, DenyListFilterData } from "./detectors/deny-list";
import type { NameCorpusData, PipelineContext } from "./context";
import { defaultContext } from "./context";
import { POST_NOMINALS } from "./config/titles";
import { LEGAL_SUFFIXES } from "./config/legal-forms";
import { loadLanguageConfigs } from "./util/lang-loader";
import { languageConfigMatches } from "./util/language-selection";

import {
  REGEX_PATTERN_ENTRIES,
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
import { initNameCorpus } from "./detectors/names";
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
  prefilter_window_bytes?: number;
  prepared_artifact_policy?: "include" | "omit";
};

export type NativeSearchOptions = {
  literal_case_insensitive?: boolean;
  literal_whole_words?: boolean;
  regex_whole_words?: boolean;
  regex_overlap_all?: boolean;
  regex_artifact_policy?: "include" | "omit";
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
  post_nominals: string[];
  sentence_terminal_currency_terms: string[];
  phone_extension_labels: string[];
  number_markers: string[];
  number_labels: string[];
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
  organization_suffixes: string[];
  organization_determiners: string[];
};
export type NativeNameCorpusData = {
  first_names: string[];
  surnames: string[];
  title_tokens: string[];
  title_abbreviations: string[];
  excluded_words: string[];
  common_words: string[];
  non_western_names: string[];
  excluded_all_caps: string[];
  ja_suffixes: string[];
  arabic_connectors: string[];
  relation_connectors: string[];
  hyphenated_prefixes: string[];
  cjk_non_person_terms: string[];
  cjk_surname_starters: string[];
  organization_terms: string[];
};
export type NativeNameCorpusMode = "full" | "supplemental";
export type NativeZonePatternData = {
  pattern: string;
  flags: string;
};
export type NativeZoneSigningClauseData = {
  prefix: string;
  suffix: string;
  prepositions: string[];
};
export type NativeZoneData = {
  section_heading_patterns: NativeZonePatternData[];
  signing_clauses: NativeZoneSigningClauseData[];
};
type GenericRolesData = {
  roles: string[];
};
type CoreferenceDeterminersData = Record<string, readonly string[] | string>;
export type NativeGazetteerData = {
  labels: string[];
  is_fuzzy: boolean[];
};

export type NativeHotwordRule = {
  hotwords: string[];
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

export type NativeSignatureData = {
  labels: string[];
  witness_phrases: string[];
  name_particles: string[];
  post_nominal_suffixes: string[];
  organization_suffixes: string[];
  image_stub_prefixes: string[];
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
  zone_data?: NativeZoneData;
  address_context_data?: NativeAddressContextData;
  coreference_data?: NativeCoreferenceData;
  name_corpus_data?: NativeNameCorpusData;
  signature_data?: NativeSignatureData;
  name_corpus_mode?: NativeNameCorpusMode;
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

type NameCorpusCjkLanguageData = {
  nonPersonTerms: string[];
  surnameStarters: string[];
};

type NameCorpusCjkData = Record<
  string,
  NameCorpusCjkLanguageData | string | undefined
>;

type NameCorpusParticleLanguageData = {
  connectors?: string[];
  relationConnectors?: string[];
  suffixes?: string[];
  hyphenatedPrefixes?: string[];
};

type NameCorpusParticleData = Record<
  string,
  NameCorpusParticleLanguageData | string | undefined
>;

type OrganizationIndicatorData = Record<string, string[] | string | undefined>;

type LanguageKeyedTerms = Record<
  string,
  readonly string[] | string | undefined
>;

type TriggerSupportData = {
  phoneExtensionLabels: LanguageKeyedTerms;
  numberMarkers: LanguageKeyedTerms;
  numberLabels: LanguageKeyedTerms;
};

type SignatureDetectionData = {
  labels: LanguageKeyedTerms;
  witnessPhrases: LanguageKeyedTerms;
  nameParticles: LanguageKeyedTerms;
  postNominalSuffixes: LanguageKeyedTerms;
  organizationSuffixes: LanguageKeyedTerms;
  imageStubPrefixes: LanguageKeyedTerms;
};

type SectionHeadingsConfig = {
  patterns: Array<{ re: string; flags: string }>;
};

type SigningClauseConfig = {
  patterns: Array<{
    lang: string;
    prefix?: string;
    suffix?: string;
    prepositions?: string[];
  }>;
};

type UnifiedSearchSources = {
  contentLanguages: readonly string[] | undefined;
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
  nativeSentenceTerminalCurrencyTerms: string[];
  nativeAddressSeedData: NativeAddressSeedData | null;
  nativeZoneData: NativeZoneData | null;
  nativeAddressContextData: NativeAddressContextData | null;
  nativeCoreferenceData: NativeCoreferenceData | null;
  nativeNameCorpusData: NativeNameCorpusData | null;
  nativeNameCorpusMode: NativeNameCorpusMode | null;
  nativeSigningPatterns: readonly PatternEntry[];
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

// eslint-disable-next-line no-unsafe-type-assertion -- JSON config module shape.
const NAME_CORPUS_CJK = nameCorpusCjk as NameCorpusCjkData;
// eslint-disable-next-line no-unsafe-type-assertion -- JSON config module shape.
const NAME_CORPUS_PARTICLES = nameCorpusParticles as NameCorpusParticleData;
// eslint-disable-next-line no-unsafe-type-assertion -- JSON config module shape.
const ORGANIZATION_INDICATORS =
  organizationIndicators as OrganizationIndicatorData;

const CJK_LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  zh: ["zh", "zh-latn", "zh-hans", "zh-hant"],
  ja: ["ja", "ja-latn"],
  ko: ["ko", "ko-latn"],
};

const buildNativeNameCorpusData = (
  config: PipelineConfig,
  corpus: NameCorpusData | null,
): NativeNameCorpusData | null => {
  if (!config.enableNameCorpus || !corpus) {
    return null;
  }

  const languages = config.nameCorpusLanguages?.map((language) =>
    language.toLowerCase(),
  );
  const cjkNonPersonTerms: string[] = [];
  const cjkSurnameStarters: string[] = [];
  for (const [language, value] of Object.entries(NAME_CORPUS_CJK)) {
    if (!isNameCorpusCjkLanguageData(value)) continue;
    if (!languageIsSelected(language, languages, CJK_LANGUAGE_ALIASES)) {
      continue;
    }
    cjkNonPersonTerms.push(...value.nonPersonTerms);
    cjkSurnameStarters.push(...value.surnameStarters);
  }

  const jaSuffixes: string[] = [];
  const arabicConnectors: string[] = [];
  const relationConnectors: string[] = [];
  const hyphenatedPrefixes: string[] = [];
  for (const [language, value] of Object.entries(NAME_CORPUS_PARTICLES)) {
    if (!isNameCorpusParticleLanguageData(value)) continue;
    if (!languageIsSelected(language, languages)) continue;
    jaSuffixes.push(...(value.suffixes ?? []));
    arabicConnectors.push(...(value.connectors ?? []));
    relationConnectors.push(...(value.relationConnectors ?? []));
    hyphenatedPrefixes.push(...(value.hyphenatedPrefixes ?? []));
  }

  const organizationTerms: string[] = [];
  for (const value of Object.values(ORGANIZATION_INDICATORS)) {
    if (Array.isArray(value)) {
      organizationTerms.push(...value);
    }
  }

  return {
    first_names: [...corpus.firstNamesList],
    surnames: [...corpus.surnamesList],
    title_tokens: [...corpus.titlesList],
    title_abbreviations: [...corpus.titleAbbreviations],
    excluded_words: [...corpus.excludedList],
    common_words: [...corpus.commonWords],
    non_western_names: [...corpus.nonWesternNamesList],
    excluded_all_caps: [...corpus.excludedAllCapsList],
    ja_suffixes: uniqueStrings(jaSuffixes),
    arabic_connectors: uniqueStrings(arabicConnectors),
    relation_connectors: uniqueStrings(relationConnectors),
    hyphenated_prefixes: uniqueStrings(hyphenatedPrefixes),
    cjk_non_person_terms: uniqueStrings(cjkNonPersonTerms),
    cjk_surname_starters: uniqueStrings(cjkSurnameStarters),
    organization_terms: uniqueStrings(organizationTerms),
  };
};

const isNameCorpusCjkLanguageData = (
  value: NameCorpusCjkData[string],
): value is NameCorpusCjkLanguageData =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray(value.nonPersonTerms) &&
  Array.isArray(value.surnameStarters);

const isNameCorpusParticleLanguageData = (
  value: NameCorpusParticleData[string],
): value is NameCorpusParticleLanguageData =>
  typeof value === "object" && value !== null;

const languageIsSelected = (
  language: string,
  selectedLanguages: readonly string[] | undefined,
  aliases: Record<string, readonly string[]> = {},
): boolean => {
  if (selectedLanguages === undefined) {
    return true;
  }
  const normalized = language.toLowerCase();
  const accepted = aliases[normalized] ?? [normalized];
  return accepted.some((entry) => selectedLanguages.includes(entry));
};

const uniqueStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const TRIGGER_SUPPORT = triggerSupport as TriggerSupportData;
const SIGNATURE_DETECTION = signatureDetection as SignatureDetectionData;

const languageKeyedTerms = (
  values: LanguageKeyedTerms,
  selectedLanguages: readonly string[] | undefined,
): string[] => {
  const result: string[] = [];
  for (const [language, terms] of Object.entries(values)) {
    if (!Array.isArray(terms)) {
      continue;
    }
    if (
      language !== "und" &&
      !languageConfigMatches(language, selectedLanguages)
    ) {
      continue;
    }
    result.push(...terms);
  }
  return uniqueStrings(result);
};

const buildNativeSignatureData = (): NativeSignatureData => ({
  labels: languageKeyedTerms(SIGNATURE_DETECTION.labels, undefined),
  witness_phrases: languageKeyedTerms(
    SIGNATURE_DETECTION.witnessPhrases,
    undefined,
  ),
  name_particles: languageKeyedTerms(
    SIGNATURE_DETECTION.nameParticles,
    undefined,
  ),
  post_nominal_suffixes: languageKeyedTerms(
    SIGNATURE_DETECTION.postNominalSuffixes,
    undefined,
  ),
  organization_suffixes: languageKeyedTerms(
    SIGNATURE_DETECTION.organizationSuffixes,
    undefined,
  ),
  image_stub_prefixes: languageKeyedTerms(
    SIGNATURE_DETECTION.imageStubPrefixes,
    undefined,
  ),
});

const buildUnifiedSearchSources = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<UnifiedSearchSources> => {
  config = applyPipelineLanguageScope(config);
  const contentLanguages = configuredContentLanguages(config);
  const legalFormsEnabled = isLegalFormsEnabled(config);
  const hotwordRules =
    config.enableHotwordRules === true ? await loadHotwordRuleSet() : [];
  const searchLabels =
    config.enableHotwordRules === true
      ? expandLabelsForHotwordRuleSet(config.labels, hotwordRules)
      : config.labels;
  const allowedLabels = createAllowedLabelSet(searchLabels);
  const regexMonetaryEnabled =
    config.enableRegex && labelIsAllowed("monetary amount", allowedLabels);
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
    nameCorpus,
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
    zoneData,
    addressContextData,
    coreferenceData,
  ] = await Promise.all([
    // Resolve this config's corpus once, up front in the same batch. The value
    // is threaded into the native corpus bake and the deny-list filters below
    // instead of read back from the shared ctx slot, which a concurrent config
    // building on the same context may have replaced.
    initNameCorpus(ctx, config.dictionaries, config.nameCorpusLanguages),
    legalFormsEnabled || config.enableTriggerPhrases || config.enableCoreference
      ? warmLegalRoleHeads()
      : Promise.resolve(),
    config.enableTriggerPhrases
      ? buildTriggerPatterns(contentLanguages)
      : Promise.resolve({
          patterns: [] as string[],
          rules: [] as TriggerRule[],
        }),
    config.enableDenyList ? buildDenyList(config, ctx) : Promise.resolve(null),
    (async () => {
      const { corpus, stopwords } = await ensureDenyListData(
        ctx,
        config.dictionaries,
        config.nameCorpusLanguages,
      );
      return buildDenyListFilterData(ctx, corpus, stopwords);
    })(),
    buildStreetTypePatterns(),
    regexMonetaryEnabled
      ? getCurrencyPatternEntries()
      : Promise.resolve([] as PatternEntry[]),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getDatePatterns(contentLanguages)
      : Promise.resolve([] as string[]),
    config.enableRegex && labelIsAllowed("address", allowedLabels)
      ? getSigningClausePatterns(contentLanguages)
      : Promise.resolve([] as string[]),
    config.enableRegex && labelIsAllowed("address", allowedLabels)
      ? getNativeSigningClausePatterns(contentLanguages)
      : Promise.resolve([] as PatternEntry[]),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getDateMonthData(contentLanguages)
      : Promise.resolve(null),
    config.enableRegex && labelIsAllowed("date", allowedLabels)
      ? getYearWordData(contentLanguages)
      : Promise.resolve(null),
    config.enableTriggerPhrases || regexMonetaryEnabled
      ? getMonetaryData()
      : Promise.resolve(null),
    labelIsAllowed("address", allowedLabels)
      ? getAddressSeedData()
      : Promise.resolve(null),
    config.enableZoneClassification
      ? buildNativeZoneData(contentLanguages)
      : Promise.resolve(null),
    labelIsAllowed("address", allowedLabels)
      ? Promise.resolve(getAddressContextData())
      : Promise.resolve(null),
    config.enableCoreference
      ? buildNativeCoreferenceData(contentLanguages)
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
  const nativeOrganizationSuffixes = config.enableCoreference
    ? [...LEGAL_SUFFIXES]
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
    for (const [index, pattern] of REGEX_PATTERN_ENTRIES.entries()) {
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
          year_words_by_language:
            config.enableTriggerPhrases === true ? (yearWordData ?? {}) : {},
        };
  const nativeMonetaryData =
    config.enableTriggerPhrases || regexMonetaryEnabled ? monetaryData : null;
  const nativeSentenceTerminalCurrencyTerms =
    sentenceTerminalCurrencyTerms(monetaryData);
  const nativeNameCorpusData = buildNativeNameCorpusData(config, nameCorpus);
  const nativeNameCorpusMode: NativeNameCorpusMode = config.enableDenyList
    ? "supplemental"
    : "full";

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
    contentLanguages,
    nativeLegalFormPatterns,
    nativeLegalFormData,
    nativeDateData,
    nativeMonetaryData,
    nativeSentenceTerminalCurrencyTerms,
    nativeAddressSeedData: addressSeedData,
    nativeZoneData: zoneData,
    nativeAddressContextData: addressContextData,
    nativeCoreferenceData:
      coreferenceData === null
        ? null
        : {
            ...coreferenceData,
            legal_form_aliases: nativeLegalFormSuffixes,
            organization_suffixes: nativeOrganizationSuffixes,
          },
    nativeNameCorpusData,
    nativeNameCorpusMode:
      nativeNameCorpusData === null ? null : nativeNameCorpusMode,
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
      contentLanguages: sources.contentLanguages,
      legalFormPatterns: sources.nativeLegalFormPatterns,
      legalFormData: sources.nativeLegalFormData,
      dateData: sources.nativeDateData,
      monetaryData: sources.nativeMonetaryData,
      sentenceTerminalCurrencyTerms:
        sources.nativeSentenceTerminalCurrencyTerms,
      addressSeedData: sources.nativeAddressSeedData,
      zoneData: sources.nativeZoneData,
      addressContextData: sources.nativeAddressContextData,
      coreferenceData: sources.nativeCoreferenceData,
      nameCorpusData: sources.nativeNameCorpusData,
      nameCorpusMode: sources.nativeNameCorpusMode,
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
    contentLanguages: sources.contentLanguages,
    legalFormPatterns: sources.nativeLegalFormPatterns,
    legalFormData: sources.nativeLegalFormData,
    dateData: sources.nativeDateData,
    monetaryData: sources.nativeMonetaryData,
    sentenceTerminalCurrencyTerms: sources.nativeSentenceTerminalCurrencyTerms,
    addressSeedData: sources.nativeAddressSeedData,
    zoneData: sources.nativeZoneData,
    addressContextData: sources.nativeAddressContextData,
    coreferenceData: sources.nativeCoreferenceData,
    nameCorpusData: sources.nativeNameCorpusData,
    nameCorpusMode: sources.nativeNameCorpusMode,
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
  customRegexes: readonly CustomRegexPattern[];
  customRegexMeta: readonly RegexMeta[];
  denyListData: DenyListData | null;
  falsePositiveFilters: DenyListFilterData;
  triggerPatterns: readonly string[];
  triggerRules: readonly TriggerRule[];
  contentLanguages: readonly string[] | undefined;
  legalFormPatterns: readonly string[];
  legalFormData: NativeLegalFormData | null;
  dateData: NativeDateData | null;
  monetaryData: NativeMonetaryData | null;
  sentenceTerminalCurrencyTerms: readonly string[];
  addressSeedData: NativeAddressSeedData | null;
  zoneData: NativeZoneData | null;
  addressContextData: NativeAddressContextData | null;
  coreferenceData: NativeCoreferenceData | null;
  nameCorpusData: NativeNameCorpusData | null;
  nameCorpusMode: NativeNameCorpusMode | null;
  nativeSigningPatterns: readonly PatternEntry[];
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
  contentLanguages,
  legalFormPatterns,
  legalFormData,
  dateData,
  monetaryData,
  sentenceTerminalCurrencyTerms,
  addressSeedData,
  zoneData,
  addressContextData,
  coreferenceData,
  nameCorpusData,
  nameCorpusMode,
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
    ...(entry.preparedArtifactPolicy === undefined
      ? {}
      : { prepared_artifact_policy: entry.preparedArtifactPolicy }),
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
    end: literalOffset,
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
    ],
    regex_options: {
      literal_case_insensitive: true,
      literal_whole_words: false,
      regex_whole_words: false,
      regex_artifact_policy: "omit",
    },
    custom_regex_options: {
      regex_whole_words: false,
      regex_overlap_all: true,
      regex_artifact_policy: "omit",
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
    signature_data: buildNativeSignatureData(),
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
      pattern_rule_indices: [],
    };
  }
  if (triggerRules.length > 0) {
    nativeConfig.trigger_data = {
      rules: triggerRules.map(toNativeTriggerRule),
      address_stop_keywords: [...getAddressStopKeywordsSync()],
      party_position_terms: [...partyPositionTerms],
      post_nominals: [...POST_NOMINALS],
      sentence_terminal_currency_terms: [...sentenceTerminalCurrencyTerms],
      phone_extension_labels: languageKeyedTerms(
        TRIGGER_SUPPORT.phoneExtensionLabels,
        contentLanguages,
      ),
      number_markers: languageKeyedTerms(
        TRIGGER_SUPPORT.numberMarkers,
        contentLanguages,
      ),
      number_labels: languageKeyedTerms(
        TRIGGER_SUPPORT.numberLabels,
        contentLanguages,
      ),
    };
  }
  if (legalFormData) {
    nativeConfig.legal_form_data = legalFormData;
  }
  if (addressSeedData) {
    nativeConfig.address_seed_data = addressSeedData;
  }
  if (zoneData) {
    nativeConfig.zone_data = zoneData;
  }
  if (addressContextData) {
    nativeConfig.address_context_data = addressContextData;
  }
  if (coreferenceData) {
    nativeConfig.coreference_data = coreferenceData;
  }
  if (nameCorpusData) {
    nativeConfig.name_corpus_data = nameCorpusData;
    if (nameCorpusMode !== null) {
      nativeConfig.name_corpus_mode = nameCorpusMode;
    }
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

const toNativeHotwordRule = (rule: HotwordRule): NativeHotwordRule => {
  const result: NativeHotwordRule = {
    hotwords: [...rule.hotwords],
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
    prefilterWindowBytes?: number;
    preparedArtifactPolicy?: "include" | "omit";
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
  if (regexEntry.prefilterWindowBytes !== undefined) {
    pattern.prefilter_window_bytes = regexEntry.prefilterWindowBytes;
  }
  if (regexEntry.preparedArtifactPolicy !== undefined) {
    pattern.prepared_artifact_policy = regexEntry.preparedArtifactPolicy;
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
    if (!isSupportedValidator || !meta.validatorId) {
      throw new Error(
        `Native static config does not support regex validator ${meta.validatorId ?? "unknown"}`,
      );
    }
    result.requires_validation = true;
    result.validator_id = meta.validatorId;
    if (meta.validatorInputKind) {
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
      meta.validatorInputKind === "digits-only" ||
      meta.validatorInputKind === "crypto-wallet-candidate")
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

const buildNativeCoreferenceData = async (
  selectedLanguages?: readonly string[],
): Promise<NativeCoreferenceData> => {
  const [roleModule, determinerModule] = await Promise.all([
    import("./data/generic-roles.json"),
    import("./data/coreference-org-determiners.json"),
  ]);
  const roleData = (roleModule.default ?? roleModule) as GenericRolesData;
  const determinerData = (determinerModule.default ??
    determinerModule) as CoreferenceDeterminersData;
  const configs = await loadLanguageConfigs<readonly CoreferenceConfigRow[]>(
    "coreference",
    (mod) => {
      const moduleValue = mod as {
        default?: readonly CoreferenceConfigRow[];
      };
      return moduleValue.default ?? (mod as readonly CoreferenceConfigRow[]);
    },
    selectedLanguages === undefined ? {} : { languages: selectedLanguages },
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
    organization_suffixes: [],
    organization_determiners: Object.entries(determinerData)
      .flatMap(([language, values]) => {
        if (language === "_comment" || !Array.isArray(values)) {
          return [];
        }
        if (!languageConfigMatches(language, selectedLanguages)) {
          return [];
        }
        return values;
      })
      .toSorted((left, right) => left.localeCompare(right)),
  };
};

const signingClauseLanguageMatches = (
  entryLanguage: string,
  selectedLanguages: readonly string[] | undefined,
): boolean => {
  if (selectedLanguages === undefined || selectedLanguages.length === 0) {
    return true;
  }
  const normalizedEntry = entryLanguage.toLowerCase();
  return selectedLanguages.some((language) => {
    const normalized = language.trim().toLowerCase();
    return (
      normalized === normalizedEntry ||
      normalized.split("-").at(0) === normalizedEntry
    );
  });
};

const buildNativeZoneData = async (
  selectedLanguages?: readonly string[],
): Promise<NativeZoneData> => {
  const [headingModule, signingModule] = await Promise.all([
    import("./data/section-headings.json"),
    import("./data/signing-clauses.json"),
  ]);
  const headingData = (headingModule.default ??
    headingModule) as SectionHeadingsConfig;
  const signingData = (signingModule.default ??
    signingModule) as SigningClauseConfig;

  return {
    section_heading_patterns: headingData.patterns.map((pattern) => ({
      pattern: pattern.re,
      flags: pattern.flags,
    })),
    signing_clauses: signingData.patterns
      .filter((pattern) =>
        signingClauseLanguageMatches(pattern.lang, selectedLanguages),
      )
      .map((pattern) => ({
        prefix: pattern.prefix ?? "",
        suffix: pattern.suffix ?? "",
        prepositions: pattern.prepositions ?? [],
      })),
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
