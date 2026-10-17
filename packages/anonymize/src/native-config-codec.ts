import type {
  PatternSlice,
  NativeSearchPattern,
  NativeSearchOptions,
  NativeRegexMatchMeta,
  NativeSigningPlaceGuardData,
  NativeDenyListFilterData,
  NativeDenyListMatchData,
  NativeTriggerStrategy,
  NativeTriggerValidation,
  NativeTriggerRule,
  NativeTriggerData,
  NativeLegalFormData,
  NativeLowercaseBridge,
  NativeDateMonthData,
  NativeYearWordData,
  NativeDateData,
  NativeMonetaryData,
  NativeStandaloneStreetData,
  NativeAddressSeedData,
  NativeAddressContextData,
  NativeCoreferencePatternData,
  NativeCoreferenceData,
  NativeNameCorpusData,
  NativeNameCorpusMode,
  NativeZonePatternData,
  NativeZoneSigningClauseData,
  NativeZoneData,
  NativeCountryData,
  NativeGazetteerInflection,
  NativeGazetteerData,
  NativeHotwordRule,
  NativeHotwordRuleData,
  NativeSignatureData,
  NativePreparedSearchConfig,
} from "./native-search-config";

import {
  arrayOf,
  isBoolean,
  isRecord,
  isNumber,
  isString,
  objectOf,
  oneOf,
  literalUnion,
  optional,
  recordOf,
  type Fields,
  type Check,
} from "./native-json-codec";

const checkPatternSlice = objectOf({
  start: isNumber,
  end: isNumber,
} satisfies Fields<PatternSlice>);
const isPatternSlice = (value: unknown): value is PatternSlice =>
  checkPatternSlice(value);

const checkNativeSearchPattern = objectOf({
  kind: literalUnion({
    literal: true,
    "literal-with-options": true,
    regex: true,
    fuzzy: true,
  } satisfies Record<NativeSearchPattern["kind"], true>),
  pattern: isString,
  distance: optional(isNumber),
  case_insensitive: optional(isBoolean),
  whole_words: optional(isBoolean),
  lazy: optional(isBoolean),
  prefilter_any: optional(arrayOf(isString)),
  prefilter_case_insensitive: optional(isBoolean),
  prefilter_regex: optional(isString),
  prefilter_window_bytes: optional(isNumber),
  prepared_artifact_policy: optional(
    literalUnion({ include: true, omit: true } satisfies Record<
      NonNullable<NativeSearchPattern["prepared_artifact_policy"]>,
      true
    >),
  ),
} satisfies Fields<NativeSearchPattern>);
const isNativeSearchPattern = (value: unknown): value is NativeSearchPattern =>
  checkNativeSearchPattern(value);

const checkNativeSearchOptions = objectOf({
  literal_case_insensitive: optional(isBoolean),
  literal_whole_words: optional(isBoolean),
  regex_whole_words: optional(isBoolean),
  regex_overlap_all: optional(isBoolean),
  regex_artifact_policy: optional(
    literalUnion({ include: true, omit: true } satisfies Record<
      NonNullable<NativeSearchOptions["regex_artifact_policy"]>,
      true
    >),
  ),
  fuzzy_case_insensitive: optional(isBoolean),
  fuzzy_whole_words: optional(isBoolean),
  fuzzy_normalize_diacritics: optional(isBoolean),
} satisfies Fields<NativeSearchOptions>);
const isNativeSearchOptions = (value: unknown): value is NativeSearchOptions =>
  checkNativeSearchOptions(value);

const checkNativeRegexMatchMeta = objectOf({
  label: isString,
  score: isNumber,
  source_detail: optional(isString),
  requires_validation: optional(isBoolean),
  validator_id: optional(isString),
  validator_input: optional(isString),
  min_byte_length: optional(isNumber),
} satisfies Fields<NativeRegexMatchMeta>);
const isNativeRegexMatchMeta = (
  value: unknown,
): value is NativeRegexMatchMeta => checkNativeRegexMatchMeta(value);

const checkNativeSigningPlaceGuardData = objectOf({
  prefix_phrases: arrayOf(isString),
  suffix_phrases: arrayOf(isString),
} satisfies Fields<NativeSigningPlaceGuardData>);
const isNativeSigningPlaceGuardData = (
  value: unknown,
): value is NativeSigningPlaceGuardData =>
  checkNativeSigningPlaceGuardData(value);

const checkNativeDenyListFilterData = objectOf({
  stopwords: arrayOf(isString),
  allow_list: arrayOf(isString),
  person_stopwords: arrayOf(isString),
  person_trailing_nouns: arrayOf(isString),
  address_trailing_nouns: arrayOf(isString),
  address_stopwords: arrayOf(isString),
  address_jurisdiction_prefixes: arrayOf(isString),
  street_types: arrayOf(isString),
  address_component_terms: arrayOf(isString),
  ambiguous_street_type_terms: arrayOf(isString),
  first_names: arrayOf(isString),
  generic_roles: arrayOf(isString),
  page_footer_markers: optional(arrayOf(isString)),
  number_abbrev_prefixes: arrayOf(isString),
  sentence_starters: arrayOf(isString),
  trailing_address_word_exclusions: arrayOf(isString),
  document_heading_words: arrayOf(isString),
  document_heading_ordinal_markers: arrayOf(isString),
  defined_term_cues: arrayOf(isString),
  signing_place_guards: arrayOf((value: unknown) =>
    isNativeSigningPlaceGuardData(value),
  ),
  title_tokens: arrayOf(isString),
} satisfies Fields<NativeDenyListFilterData>);
const isNativeDenyListFilterData = (
  value: unknown,
): value is NativeDenyListFilterData => checkNativeDenyListFilterData(value);

const checkNativeDenyListMatchData = objectOf({
  labels: optional(arrayOf(arrayOf(isString))),
  label_table: optional(arrayOf(isString)),
  label_indices: optional(arrayOf(arrayOf(isNumber))),
  custom_labels: optional(arrayOf(arrayOf(isString))),
  custom_label_indices: optional(arrayOf(arrayOf(isNumber))),
  originals: arrayOf(isString),
  sources: optional(arrayOf(arrayOf(isString))),
  source_table: optional(arrayOf(isString)),
  source_indices: optional(arrayOf(arrayOf(isNumber))),
  filters: optional((value: unknown) => isNativeDenyListFilterData(value)),
} satisfies Fields<NativeDenyListMatchData>);
const isNativeDenyListMatchData = (
  value: unknown,
): value is NativeDenyListMatchData => checkNativeDenyListMatchData(value);

const checkNativeTriggerStrategy = oneOf(
  ...Object.values({
    "to-next-comma": objectOf({
      type: (value: unknown) => value === "to-next-comma",
      stop_words: optional(arrayOf(isString)),
      max_length: optional(isNumber),
    } satisfies Fields<
      Extract<NativeTriggerStrategy, { type: "to-next-comma" }>
    >),
    "to-end-of-line": objectOf({
      type: (value: unknown) => value === "to-end-of-line",
    } satisfies Fields<
      Extract<NativeTriggerStrategy, { type: "to-end-of-line" }>
    >),
    "n-words": objectOf({
      type: (value: unknown) => value === "n-words",
      count: isNumber,
    } satisfies Fields<Extract<NativeTriggerStrategy, { type: "n-words" }>>),
    "company-id-value": objectOf({
      type: (value: unknown) => value === "company-id-value",
    } satisfies Fields<
      Extract<NativeTriggerStrategy, { type: "company-id-value" }>
    >),
    address: objectOf({
      type: (value: unknown) => value === "address",
      max_chars: optional(isNumber),
    } satisfies Fields<Extract<NativeTriggerStrategy, { type: "address" }>>),
    "match-pattern": objectOf({
      type: (value: unknown) => value === "match-pattern",
      pattern: isString,
      flags: optional(isString),
    } satisfies Fields<
      Extract<NativeTriggerStrategy, { type: "match-pattern" }>
    >),
  } satisfies Record<NativeTriggerStrategy["type"], Check>),
);
const isNativeTriggerStrategy = (
  value: unknown,
): value is NativeTriggerStrategy => checkNativeTriggerStrategy(value);

const checkNativeTriggerValidation = oneOf(
  ...Object.values({
    "starts-uppercase": objectOf({
      type: (value: unknown) => value === "starts-uppercase",
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "starts-uppercase" }>
    >),
    "min-length": objectOf({
      type: (value: unknown) => value === "min-length",
      min: isNumber,
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "min-length" }>
    >),
    "max-length": objectOf({
      type: (value: unknown) => value === "max-length",
      max: isNumber,
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "max-length" }>
    >),
    "no-digits": objectOf({
      type: (value: unknown) => value === "no-digits",
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "no-digits" }>
    >),
    "has-digits": objectOf({
      type: (value: unknown) => value === "has-digits",
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "has-digits" }>
    >),
    "matches-pattern": objectOf({
      type: (value: unknown) => value === "matches-pattern",
      pattern: isString,
      flags: optional(isString),
    } satisfies Fields<
      Extract<NativeTriggerValidation, { type: "matches-pattern" }>
    >),
    "valid-id": objectOf({
      type: (value: unknown) => value === "valid-id",
      validator: isString,
    } satisfies Fields<Extract<NativeTriggerValidation, { type: "valid-id" }>>),
  } satisfies Record<NativeTriggerValidation["type"], Check>),
);
const isNativeTriggerValidation = (
  value: unknown,
): value is NativeTriggerValidation => checkNativeTriggerValidation(value);

const checkNativeTriggerRule = objectOf({
  trigger: isString,
  label: isString,
  strategy: (value: unknown) => isNativeTriggerStrategy(value),
  validations: arrayOf((value: unknown) => isNativeTriggerValidation(value)),
  include_trigger: isBoolean,
} satisfies Fields<NativeTriggerRule>);
const isNativeTriggerRule = (value: unknown): value is NativeTriggerRule =>
  checkNativeTriggerRule(value);

const checkNativeTriggerData = objectOf({
  rules: arrayOf((value: unknown) => isNativeTriggerRule(value)),
  address_stop_keywords: arrayOf(isString),
  party_position_terms: arrayOf(isString),
  post_nominals: arrayOf(isString),
  sentence_terminal_currency_terms: arrayOf(isString),
  phone_extension_labels: arrayOf(isString),
  number_markers: arrayOf(isString),
  number_labels: arrayOf(isString),
  person_field_labels: arrayOf(isString),
} satisfies Fields<NativeTriggerData>);
const isNativeTriggerData = (value: unknown): value is NativeTriggerData =>
  checkNativeTriggerData(value);

const checkNativeLegalFormData = objectOf({
  suffixes: arrayOf(isString),
  non_ascii_name_short_suffixes: arrayOf(isString),
  detection_only_suffixes: arrayOf(isString),
  institutional_heads: arrayOf(isString),
  normalized_boundary_suffixes: arrayOf(isString),
  normalized_in_name_words: arrayOf(isString),
  normalized_suffix_words: arrayOf(isString),
  role_heads: arrayOf(isString),
  sentence_verb_indicators: arrayOf(isString),
  clause_noun_heads: arrayOf(isString),
  connector_prose_heads: arrayOf(isString),
  structural_single_cap_prefixes: arrayOf(isString),
  leading_clause_phrases: arrayOf(isString),
  leading_clause_direct_prefixes: arrayOf(isString),
  connector_words: arrayOf(isString),
  and_connector_words: arrayOf(isString),
  in_name_prepositions: arrayOf(isString),
  company_suffix_words: arrayOf(isString),
  comma_gated_direct_prefixes: arrayOf(isString),
  institutional_complement_heads: arrayOf(isString),
  institutional_complement_starters: arrayOf(isString),
  institutional_complement_connectors: arrayOf(isString),
  institutional_generic_words: arrayOf(isString),
  institutional_prefix_generic_words: arrayOf(isString),
  lowercase_bridge: (value: unknown) => isNativeLowercaseBridge(value),
} satisfies Fields<NativeLegalFormData>);
const isNativeLegalFormData = (value: unknown): value is NativeLegalFormData =>
  checkNativeLegalFormData(value);

const checkNativeLowercaseBridge = objectOf({
  policy: literalUnion({ open: true, closed: true } satisfies Record<
    NativeLowercaseBridge["policy"],
    true
  >),
  words: arrayOf(isString),
} satisfies Fields<NativeLowercaseBridge>);
const isNativeLowercaseBridge = (
  value: unknown,
): value is NativeLowercaseBridge => checkNativeLowercaseBridge(value);

const checkNativeDateMonthData = recordOf(arrayOf(isString));
const isNativeDateMonthData = (value: unknown): value is NativeDateMonthData =>
  checkNativeDateMonthData(value);

const checkNativeYearWordData = recordOf(arrayOf(isString));
const isNativeYearWordData = (value: unknown): value is NativeYearWordData =>
  checkNativeYearWordData(value);

const checkNativeDateData = objectOf({
  month_names_by_language: (value: unknown) => isNativeDateMonthData(value),
  lowercase_month_ambiguities: (value: unknown) => isNativeDateMonthData(value),
  year_words_by_language: (value: unknown) => isNativeYearWordData(value),
} satisfies Fields<NativeDateData>);
const isNativeDateData = (value: unknown): value is NativeDateData =>
  checkNativeDateData(value);

const checkNativeMonetaryData = objectOf({
  currencies: objectOf({
    codes: arrayOf(isString),
    symbols: arrayOf(isString),
    local_names: arrayOf(isString),
  } satisfies Fields<NativeMonetaryData["currencies"]>),
  amount_words: objectOf({
    written_amount_patterns: arrayOf(
      objectOf({
        keywords: arrayOf(isString),
      } satisfies Fields<
        NativeMonetaryData["amount_words"]["written_amount_patterns"][number]
      >),
    ),
    number_words: arrayOf(
      objectOf({
        words: arrayOf(isString),
        joiners: arrayOf(isString),
      } satisfies Fields<
        NativeMonetaryData["amount_words"]["number_words"][number]
      >),
    ),
    magnitude_suffixes: arrayOf(
      objectOf({
        words: arrayOf(isString),
        abbreviations_case_insensitive: arrayOf(isString),
        abbreviations_case_sensitive: arrayOf(isString),
        abbreviations_attached: arrayOf(isString),
      } satisfies Fields<
        NativeMonetaryData["amount_words"]["magnitude_suffixes"][number]
      >),
    ),
    share_quantity_terms: arrayOf(
      objectOf({
        modifiers: arrayOf(isString),
        nouns: arrayOf(isString),
      } satisfies Fields<
        NativeMonetaryData["amount_words"]["share_quantity_terms"][number]
      >),
    ),
  } satisfies Fields<NativeMonetaryData["amount_words"]>),
} satisfies Fields<NativeMonetaryData>);
const isNativeMonetaryData = (value: unknown): value is NativeMonetaryData =>
  checkNativeMonetaryData(value);

const checkNativeStandaloneStreetData = objectOf({
  street_type_words: arrayOf(isString),
} satisfies Fields<NativeStandaloneStreetData>);
const isNativeStandaloneStreetData = (
  value: unknown,
): value is NativeStandaloneStreetData =>
  checkNativeStandaloneStreetData(value);

const checkNativeAddressSeedData = objectOf({
  boundary_words: arrayOf(isString),
  br_cep_cue_words: arrayOf(isString),
  unit_abbreviations: arrayOf(isString),
  directional_abbreviations: arrayOf(isString),
  standalone_street: optional((value: unknown) =>
    isNativeStandaloneStreetData(value),
  ),
} satisfies Fields<NativeAddressSeedData>);
const isNativeAddressSeedData = (
  value: unknown,
): value is NativeAddressSeedData => checkNativeAddressSeedData(value);

const checkNativeAddressContextData = objectOf({
  address_prepositions: arrayOf(isString),
  temporal_prepositions: arrayOf(isString),
  street_abbreviations: arrayOf(isString),
  bare_house_stopwords: arrayOf(isString),
} satisfies Fields<NativeAddressContextData>);
const isNativeAddressContextData = (
  value: unknown,
): value is NativeAddressContextData => checkNativeAddressContextData(value);

const checkNativeCoreferencePatternData = objectOf({
  pattern: isString,
  flags: isString,
} satisfies Fields<NativeCoreferencePatternData>);
const isNativeCoreferencePatternData = (
  value: unknown,
): value is NativeCoreferencePatternData =>
  checkNativeCoreferencePatternData(value);

const checkNativeCoreferenceData = objectOf({
  definition_patterns: arrayOf((value: unknown) =>
    isNativeCoreferencePatternData(value),
  ),
  role_stop_terms: arrayOf(isString),
  legal_form_aliases: arrayOf(isString),
  organization_suffixes: arrayOf(isString),
  organization_determiners: arrayOf(isString),
} satisfies Fields<NativeCoreferenceData>);
const isNativeCoreferenceData = (
  value: unknown,
): value is NativeCoreferenceData => checkNativeCoreferenceData(value);

const checkNativeNameCorpusData = objectOf({
  first_names: arrayOf(isString),
  surnames: arrayOf(isString),
  title_tokens: arrayOf(isString),
  title_abbreviations: arrayOf(isString),
  excluded_words: arrayOf(isString),
  common_words: arrayOf(isString),
  non_western_names: arrayOf(isString),
  excluded_all_caps: arrayOf(isString),
  ja_suffixes: arrayOf(isString),
  arabic_connectors: arrayOf(isString),
  relation_connectors: arrayOf(isString),
  hyphenated_prefixes: arrayOf(isString),
  cjk_non_person_terms: arrayOf(isString),
  cjk_surname_starters: arrayOf(isString),
  organization_terms: arrayOf(isString),
} satisfies Fields<NativeNameCorpusData>);
const isNativeNameCorpusData = (
  value: unknown,
): value is NativeNameCorpusData => checkNativeNameCorpusData(value);

const checkNativeNameCorpusMode = literalUnion({
  full: true,
  supplemental: true,
} satisfies Record<NativeNameCorpusMode, true>);
const isNativeNameCorpusMode = (
  value: unknown,
): value is NativeNameCorpusMode => checkNativeNameCorpusMode(value);

const checkNativeZonePatternData = objectOf({
  pattern: isString,
  flags: isString,
} satisfies Fields<NativeZonePatternData>);
const isNativeZonePatternData = (
  value: unknown,
): value is NativeZonePatternData => checkNativeZonePatternData(value);

const checkNativeZoneSigningClauseData = objectOf({
  prefix: isString,
  suffix: isString,
  prepositions: arrayOf(isString),
} satisfies Fields<NativeZoneSigningClauseData>);
const isNativeZoneSigningClauseData = (
  value: unknown,
): value is NativeZoneSigningClauseData =>
  checkNativeZoneSigningClauseData(value);

const checkNativeZoneData = objectOf({
  section_heading_patterns: arrayOf((value: unknown) =>
    isNativeZonePatternData(value),
  ),
  signing_clauses: arrayOf((value: unknown) =>
    isNativeZoneSigningClauseData(value),
  ),
} satisfies Fields<NativeZoneData>);
const isNativeZoneData = (value: unknown): value is NativeZoneData =>
  checkNativeZoneData(value);

const checkNativeCountryData = objectOf({
  labels: arrayOf(isString),
  isoCodes: arrayOf(isString),
  variants: arrayOf(
    literalUnion({
      name: true,
      alias: true,
      alpha3: true,
      alpha2: true,
    } satisfies Record<NativeCountryData["variants"][number], true>),
  ),
} satisfies Fields<NativeCountryData>);
const isNativeCountryData = (value: unknown): value is NativeCountryData =>
  checkNativeCountryData(value);

const checkNativeGazetteerInflection = literalUnion({
  none: true,
  czech_slovak: true,
} satisfies Record<NativeGazetteerInflection, true>);
const isNativeGazetteerInflection = (
  value: unknown,
): value is NativeGazetteerInflection => checkNativeGazetteerInflection(value);

const checkNativeGazetteerData = objectOf({
  labels: arrayOf(isString),
  is_fuzzy: arrayOf(isBoolean),
  legal_form_suffixes: arrayOf(isString),
  inflection: (value: unknown) => isNativeGazetteerInflection(value),
  terms: arrayOf(isString),
  person_forms: optional(arrayOf(isBoolean)),
} satisfies Fields<NativeGazetteerData>);
const isNativeGazetteerData = (value: unknown): value is NativeGazetteerData =>
  checkNativeGazetteerData(value);

const checkNativeHotwordRule = objectOf({
  hotwords: arrayOf(isString),
  target_labels: arrayOf(isString),
  score_adjustment: isNumber,
  reclassify_to: optional(isString),
  proximity_before: isNumber,
  proximity_after: isNumber,
} satisfies Fields<NativeHotwordRule>);
const isNativeHotwordRule = (value: unknown): value is NativeHotwordRule =>
  checkNativeHotwordRule(value);

const checkNativeHotwordRuleData = objectOf({
  rules: arrayOf((value: unknown) => isNativeHotwordRule(value)),
  pattern_rule_indices: arrayOf(isNumber),
} satisfies Fields<NativeHotwordRuleData>);
const isNativeHotwordRuleData = (
  value: unknown,
): value is NativeHotwordRuleData => checkNativeHotwordRuleData(value);

const checkNativeSignatureData = objectOf({
  labels: arrayOf(isString),
  person_value_labels: arrayOf(isString),
  person_list_labels: arrayOf(isString),
  party_role_name_evidence: isString,
  witness_phrases: arrayOf(isString),
  name_particles: arrayOf(isString),
  post_nominal_suffixes: arrayOf(isString),
  organization_suffixes: arrayOf(isString),
  form_field_labels: arrayOf(isString),
  contact_field_labels: arrayOf(isString),
  signature_stamp_phrases: arrayOf(isString),
  image_stub_prefixes: arrayOf(isString),
} satisfies Fields<NativeSignatureData>);
const isNativeSignatureData = (value: unknown): value is NativeSignatureData =>
  checkNativeSignatureData(value);

const checkNativePreparedSearchConfig = objectOf({
  regex_patterns: arrayOf((value: unknown) => isNativeSearchPattern(value)),
  custom_regex_patterns: arrayOf((value: unknown) =>
    isNativeSearchPattern(value),
  ),
  literal_patterns: arrayOf((value: unknown) => isNativeSearchPattern(value)),
  regex_options: (value: unknown) => isNativeSearchOptions(value),
  custom_regex_options: (value: unknown) => isNativeSearchOptions(value),
  literal_options: (value: unknown) => isNativeSearchOptions(value),
  literal_patterns_from_deny_list_data: optional(isBoolean),
  allowed_labels: arrayOf(isString),
  threshold: isNumber,
  confidence_boost: isBoolean,
  slices: objectOf({
    regex: optional((value: unknown) => isPatternSlice(value)),
    custom_regex: optional((value: unknown) => isPatternSlice(value)),
    legal_forms: optional((value: unknown) => isPatternSlice(value)),
    triggers: optional((value: unknown) => isPatternSlice(value)),
    deny_list: optional((value: unknown) => isPatternSlice(value)),
    street_types: optional((value: unknown) => isPatternSlice(value)),
    gazetteer: optional((value: unknown) => isPatternSlice(value)),
    countries: optional((value: unknown) => isPatternSlice(value)),
    hotwords: optional((value: unknown) => isPatternSlice(value)),
  } satisfies Fields<NativePreparedSearchConfig["slices"]>),
  regex_meta: arrayOf((value: unknown) => isNativeRegexMatchMeta(value)),
  custom_regex_meta: arrayOf((value: unknown) => isNativeRegexMatchMeta(value)),
  deny_list_data: optional((value: unknown) =>
    isNativeDenyListMatchData(value),
  ),
  false_positive_filters: optional((value: unknown) =>
    isNativeDenyListFilterData(value),
  ),
  gazetteer_data: optional((value: unknown) => isNativeGazetteerData(value)),
  country_data: optional((value: unknown) => isNativeCountryData(value)),
  hotword_data: optional((value: unknown) => isNativeHotwordRuleData(value)),
  trigger_data: optional((value: unknown) => isNativeTriggerData(value)),
  legal_form_data: optional((value: unknown) => isNativeLegalFormData(value)),
  address_seed_data: optional((value: unknown) =>
    isNativeAddressSeedData(value),
  ),
  zone_data: optional((value: unknown) => isNativeZoneData(value)),
  address_context_data: optional((value: unknown) =>
    isNativeAddressContextData(value),
  ),
  coreference_data: optional((value: unknown) =>
    isNativeCoreferenceData(value),
  ),
  name_corpus_data: optional((value: unknown) => isNativeNameCorpusData(value)),
  signature_data: optional((value: unknown) => isNativeSignatureData(value)),
  name_corpus_mode: optional((value: unknown) => isNativeNameCorpusMode(value)),
  date_data: optional((value: unknown) => isNativeDateData(value)),
  monetary_data: optional((value: unknown) => isNativeMonetaryData(value)),
} satisfies Fields<NativePreparedSearchConfig>);
const isNativePreparedSearchConfig = (
  value: unknown,
): value is NativePreparedSearchConfig =>
  checkNativePreparedSearchConfig(value);

// Serde represents absent Option fields as null. Keep the TypeScript domain
// model optional, including nested pattern metadata and inactive lane slices.
const normalizeOptionalFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeOptionalFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, normalizeOptionalFields(entry)]),
  );
};

export const parseNativePreparedSearchConfig = (
  json: string,
): NativePreparedSearchConfig => {
  const input: unknown = JSON.parse(json);
  if (!isRecord(input))
    throw new TypeError("Invalid native prepared search config");
  const defaults = {
    regex_patterns: [],
    custom_regex_patterns: [],
    literal_patterns: [],
    regex_options: {},
    custom_regex_options: {},
    literal_options: {},
    allowed_labels: [],
    threshold: 0,
    confidence_boost: false,
    slices: {},
    regex_meta: [],
    custom_regex_meta: [],
  } satisfies NativePreparedSearchConfig;
  const value = normalizeOptionalFields({
    ...defaults,
    ...input,
    regex_options: input["regex_options"] ?? {},
    custom_regex_options: input["custom_regex_options"] ?? {},
    literal_options: input["literal_options"] ?? {},
  });
  if (!isNativePreparedSearchConfig(value))
    throw new TypeError("Invalid native prepared search config");
  return value;
};
