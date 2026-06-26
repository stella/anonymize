use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use stella_anonymize_core::{
  AddressContextData, AddressSeedData, AmountWordsData, CoreferenceData,
  CoreferencePatternData, CountryMatchData, CurrencyData, DateData,
  DenyListFilterData, DenyListMatchData, DetectionSource, DiagnosticEvent,
  DiagnosticEventKind, DiagnosticStage, FuzzySearchOptions, GazetteerMatchData,
  HotwordRule, HotwordRuleData, LegalFormData, LiteralSearchOptions,
  MagnitudeSuffixData, MonetaryData, NameCorpusData, OperatorConfig,
  OperatorType, PatternSlice, PreparedSearchConfig, PreparedSearchSlices,
  RegexMatchMeta, RegexSearchOptions, SearchEngine, SearchOptions,
  SearchPattern, ShareQuantityTermData, SigningPlaceGuardData, SourceDetail,
  StaticRedactionDiagnosticResult, StaticRedactionDiagnostics,
  StaticRedactionResult, StringGroups, TriggerData, TriggerRule,
  TriggerStrategy, TriggerValidation, WrittenAmountPatternData, ZoneData,
  ZonePatternData, ZoneSigningClauseData,
};

pub type Result<T> = std::result::Result<T, ContractError>;

const PREPARED_SEARCH_PACKAGE_HEADER: [u8; 8] = *b"ANONPKG1";
const PREPARED_SEARCH_PACKAGE_VERSION: u32 = 11;
const PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER: [u8; 8] = *b"ANONPKZ1";
const PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION: u32 = 9;
const PREPARED_SEARCH_CORE_PACKAGE_HEADER: [u8; 8] = *b"ANONCPK1";
const PREPARED_SEARCH_CORE_PACKAGE_VERSION: u32 = 10;
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER: [u8; 8] = *b"ANONCPZ1";
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION: u32 = 10;
const PREPARED_SEARCH_PACKAGE_DIGEST_BYTES: usize = 32;
const PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL: i32 = 3;
const MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
  CompactStringIndexOutOfRange { field: &'static str, index: u32 },
  FuzzyDistanceOutOfRange { distance: u32 },
  InvalidCompactStringGroups { field: &'static str, reason: String },
  InvalidBindingOffset { offset: u32 },
  InvalidPreparedSearchPackage { reason: String },
  MissingDenyListDataForLiteralPatterns,
  UnsupportedOperator { value: String },
  UnsupportedSearchPatternKind { kind: String },
  UnsupportedSourceDetail { value: String },
}

impl std::fmt::Display for ContractError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::CompactStringIndexOutOfRange { field, index } => {
        write!(
          formatter,
          "Compact string index out of range in {field}: {index}"
        )
      }
      Self::FuzzyDistanceOutOfRange { distance } => {
        write!(formatter, "Fuzzy distance exceeds u8 range: {distance}")
      }
      Self::InvalidCompactStringGroups { field, reason } => {
        write!(
          formatter,
          "Compact string groups are invalid in {field}: {reason}"
        )
      }
      Self::InvalidBindingOffset { offset } => {
        write!(
          formatter,
          "Byte offset is not on a character boundary: {offset}"
        )
      }
      Self::InvalidPreparedSearchPackage { reason } => {
        write!(formatter, "Prepared search package is invalid: {reason}")
      }
      Self::MissingDenyListDataForLiteralPatterns => formatter.write_str(
        "Deny-list data is required when literal patterns are derived from it",
      ),
      Self::UnsupportedOperator { value } => {
        write!(formatter, "Unsupported anonymization operator: {value}")
      }
      Self::UnsupportedSearchPatternKind { kind } => {
        write!(formatter, "Unsupported search pattern kind: {kind}")
      }
      Self::UnsupportedSourceDetail { value } => {
        write!(formatter, "Unsupported source detail: {value}")
      }
    }
  }
}

impl std::error::Error for ContractError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingSearchPattern {
  pub kind: String,
  pub pattern: String,
  pub distance: Option<u32>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
  pub lazy: Option<bool>,
  pub prefilter_any: Option<Vec<String>>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub regex_overlap_all: Option<bool>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
pub struct BindingPatternSlice {
  pub start: u32,
  pub end: u32,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
pub struct BindingPreparedSearchSlices {
  pub regex: Option<BindingPatternSlice>,
  pub custom_regex: Option<BindingPatternSlice>,
  pub legal_forms: Option<BindingPatternSlice>,
  pub triggers: Option<BindingPatternSlice>,
  pub deny_list: Option<BindingPatternSlice>,
  pub street_types: Option<BindingPatternSlice>,
  pub gazetteer: Option<BindingPatternSlice>,
  pub countries: Option<BindingPatternSlice>,
  pub hotwords: Option<BindingPatternSlice>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BindingRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingGazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingCountryMatchData {
  pub labels: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BindingHotwordRuleData {
  #[serde(default)]
  pub rules: Vec<BindingHotwordRule>,
  #[serde(default)]
  pub pattern_rule_indices: Vec<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BindingHotwordRule {
  #[serde(default)]
  pub hotwords: Vec<String>,
  #[serde(default)]
  pub target_labels: Vec<String>,
  pub score_adjustment: f64,
  pub reclassify_to: Option<String>,
  pub proximity_before: u32,
  pub proximity_after: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingTriggerData {
  pub rules: Vec<BindingTriggerRule>,
  #[serde(default)]
  pub address_stop_keywords: Vec<String>,
  #[serde(default)]
  pub party_position_terms: Vec<String>,
  #[serde(default)]
  pub post_nominals: Vec<String>,
  #[serde(default)]
  pub sentence_terminal_currency_terms: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingTriggerRule {
  pub trigger: String,
  pub label: String,
  pub strategy: BindingTriggerStrategy,
  pub validations: Vec<BindingTriggerValidation>,
  pub include_trigger: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BindingTriggerStrategy {
  ToNextComma {
    #[serde(default)]
    stop_words: Vec<String>,
    max_length: Option<u32>,
  },
  ToEndOfLine,
  NWords {
    count: u32,
  },
  CompanyIdValue,
  Address {
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BindingTriggerValidation {
  StartsUppercase,
  MinLength {
    min: u32,
  },
  MaxLength {
    max: u32,
  },
  NoDigits,
  HasDigits,
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingLegalFormData {
  #[serde(default)]
  pub suffixes: Vec<String>,
  #[serde(default)]
  pub normalized_boundary_suffixes: Vec<String>,
  #[serde(default)]
  pub normalized_in_name_words: Vec<String>,
  #[serde(default)]
  pub normalized_suffix_words: Vec<String>,
  #[serde(default)]
  pub role_heads: Vec<String>,
  #[serde(default)]
  pub sentence_verb_indicators: Vec<String>,
  #[serde(default)]
  pub clause_noun_heads: Vec<String>,
  #[serde(default)]
  pub connector_prose_heads: Vec<String>,
  #[serde(default)]
  pub structural_single_cap_prefixes: Vec<String>,
  #[serde(default)]
  pub leading_clause_phrases: Vec<String>,
  #[serde(default)]
  pub leading_clause_direct_prefixes: Vec<String>,
  #[serde(default)]
  pub connector_words: Vec<String>,
  #[serde(default)]
  pub and_connector_words: Vec<String>,
  #[serde(default)]
  pub in_name_prepositions: Vec<String>,
  #[serde(default)]
  pub company_suffix_words: Vec<String>,
  #[serde(default)]
  pub comma_gated_direct_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingDateData {
  #[serde(default)]
  pub month_names_by_language: BTreeMap<String, Vec<String>>,
  #[serde(default)]
  pub year_words_by_language: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingMonetaryData {
  #[serde(default)]
  pub currencies: BindingCurrencyData,
  #[serde(default)]
  pub amount_words: BindingAmountWordsData,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingCurrencyData {
  #[serde(default)]
  pub codes: Vec<String>,
  #[serde(default)]
  pub symbols: Vec<String>,
  #[serde(default)]
  pub local_names: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingAmountWordsData {
  #[serde(default)]
  pub written_amount_patterns: Vec<BindingWrittenAmountPatternData>,
  #[serde(default)]
  pub magnitude_suffixes: Vec<BindingMagnitudeSuffixData>,
  #[serde(default)]
  pub share_quantity_terms: Vec<BindingShareQuantityTermData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingWrittenAmountPatternData {
  #[serde(default)]
  pub keywords: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingMagnitudeSuffixData {
  #[serde(default)]
  pub words: Vec<String>,
  #[serde(default)]
  pub abbreviations_case_insensitive: Vec<String>,
  #[serde(default)]
  pub abbreviations_case_sensitive: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingShareQuantityTermData {
  #[serde(default)]
  pub modifiers: Vec<String>,
  #[serde(default)]
  pub nouns: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingAddressSeedData {
  #[serde(default)]
  pub boundary_words: Vec<String>,
  #[serde(default)]
  pub br_cep_cue_words: Vec<String>,
  #[serde(default)]
  pub unit_abbreviations: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingAddressContextData {
  #[serde(default)]
  pub address_prepositions: Vec<String>,
  #[serde(default)]
  pub temporal_prepositions: Vec<String>,
  #[serde(default)]
  pub street_abbreviations: Vec<String>,
  #[serde(default)]
  pub bare_house_stopwords: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingZoneData {
  #[serde(default)]
  pub section_heading_patterns: Vec<BindingZonePatternData>,
  #[serde(default)]
  pub signing_clauses: Vec<BindingZoneSigningClauseData>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingZonePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingZoneSigningClauseData {
  #[serde(default)]
  pub prefix: String,
  #[serde(default)]
  pub suffix: String,
  #[serde(default)]
  pub prepositions: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingCoreferenceData {
  #[serde(default)]
  pub definition_patterns: Vec<BindingCoreferencePatternData>,
  #[serde(default)]
  pub role_stop_terms: Vec<String>,
  #[serde(default)]
  pub legal_form_aliases: Vec<String>,
  #[serde(default)]
  pub organization_determiners: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingCoreferencePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingNameCorpusData {
  #[serde(default)]
  pub first_names: Vec<String>,
  #[serde(default)]
  pub surnames: Vec<String>,
  #[serde(default)]
  pub title_tokens: Vec<String>,
  #[serde(default)]
  pub title_abbreviations: Vec<String>,
  #[serde(default)]
  pub excluded_words: Vec<String>,
  #[serde(default)]
  pub common_words: Vec<String>,
  #[serde(default)]
  pub non_western_names: Vec<String>,
  #[serde(default)]
  pub excluded_all_caps: Vec<String>,
  #[serde(default)]
  pub ja_suffixes: Vec<String>,
  #[serde(default)]
  pub arabic_connectors: Vec<String>,
  #[serde(default)]
  pub relation_connectors: Vec<String>,
  #[serde(default)]
  pub hyphenated_prefixes: Vec<String>,
  #[serde(default)]
  pub cjk_non_person_terms: Vec<String>,
  #[serde(default)]
  pub cjk_surname_starters: Vec<String>,
  #[serde(default)]
  pub organization_terms: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingDenyListMatchData {
  #[serde(default)]
  pub labels: Vec<Vec<String>>,
  #[serde(default)]
  pub label_table: Vec<String>,
  #[serde(default)]
  pub label_indices: Vec<Vec<u32>>,
  #[serde(default)]
  pub custom_labels: Vec<Vec<String>>,
  #[serde(default)]
  pub custom_label_indices: Vec<Vec<u32>>,
  pub originals: Vec<String>,
  #[serde(default)]
  pub sources: Vec<Vec<String>>,
  #[serde(default)]
  pub source_table: Vec<String>,
  #[serde(default)]
  pub source_indices: Vec<Vec<u32>>,
  pub filters: Option<BindingDenyListFilterData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingDenyListFilterData {
  pub stopwords: Vec<String>,
  pub allow_list: Vec<String>,
  pub person_stopwords: Vec<String>,
  #[serde(default)]
  pub person_trailing_nouns: Vec<String>,
  pub address_stopwords: Vec<String>,
  #[serde(default)]
  pub address_jurisdiction_prefixes: Vec<String>,
  pub street_types: Vec<String>,
  #[serde(default)]
  pub address_component_terms: Vec<String>,
  #[serde(default)]
  pub ambiguous_street_type_terms: Vec<String>,
  pub first_names: Vec<String>,
  pub generic_roles: Vec<String>,
  #[serde(default)]
  pub number_abbrev_prefixes: Vec<String>,
  pub sentence_starters: Vec<String>,
  pub trailing_address_word_exclusions: Vec<String>,
  #[serde(default)]
  pub document_heading_words: Vec<String>,
  #[serde(default)]
  pub document_heading_ordinal_markers: Vec<String>,
  pub defined_term_cues: Vec<String>,
  #[serde(default)]
  pub signing_place_guards: Vec<BindingSigningPlaceGuardData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingSigningPlaceGuardData {
  #[serde(default)]
  pub prefix_phrases: Vec<String>,
  #[serde(default)]
  pub suffix_phrases: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BindingPreparedSearchConfig {
  #[serde(default)]
  pub regex_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub custom_regex_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub literal_patterns: Vec<BindingSearchPattern>,
  #[serde(default)]
  pub regex_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub custom_regex_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub literal_options: Option<BindingSearchOptions>,
  #[serde(default)]
  pub literal_patterns_from_deny_list_data: bool,
  #[serde(default)]
  pub allowed_labels: Vec<String>,
  #[serde(default)]
  pub threshold: f64,
  #[serde(default)]
  pub confidence_boost: bool,
  #[serde(default)]
  pub slices: BindingPreparedSearchSlices,
  #[serde(default)]
  pub regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub custom_regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub deny_list_data: Option<BindingDenyListMatchData>,
  #[serde(default)]
  pub false_positive_filters: Option<BindingDenyListFilterData>,
  #[serde(default)]
  pub gazetteer_data: Option<BindingGazetteerMatchData>,
  #[serde(default)]
  pub country_data: Option<BindingCountryMatchData>,
  #[serde(default)]
  pub hotword_data: Option<BindingHotwordRuleData>,
  #[serde(default)]
  pub trigger_data: Option<BindingTriggerData>,
  #[serde(default)]
  pub legal_form_data: Option<BindingLegalFormData>,
  #[serde(default)]
  pub address_seed_data: Option<BindingAddressSeedData>,
  #[serde(default)]
  pub zone_data: Option<BindingZoneData>,
  #[serde(default)]
  pub address_context_data: Option<BindingAddressContextData>,
  #[serde(default)]
  pub coreference_data: Option<BindingCoreferenceData>,
  #[serde(default)]
  pub name_corpus_data: Option<BindingNameCorpusData>,
  #[serde(default)]
  pub date_data: Option<BindingDateData>,
  #[serde(default)]
  pub monetary_data: Option<BindingMonetaryData>,
}

#[derive(Deserialize)]
struct BinaryPreparedSearchPackageOwned {
  config: BinaryPreparedSearchConfig,
  artifacts: Vec<u8>,
}

#[derive(Serialize)]
struct BinaryPreparedSearchPackageRef<'a> {
  config: BinaryPreparedSearchConfig,
  artifacts: &'a [u8],
}

#[derive(Clone, Debug, PartialEq)]
pub struct BindingPreparedSearchPackage {
  pub config: BindingPreparedSearchConfig,
  pub artifacts: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackage {
  pub config: PreparedSearchConfig,
  pub artifacts: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackageView<'a> {
  pub config: PreparedSearchConfig,
  pub artifacts: Cow<'a, [u8]>,
}

#[derive(Deserialize, Serialize)]
struct BinaryPreparedSearchConfig {
  regex_patterns: Vec<BindingSearchPattern>,
  custom_regex_patterns: Vec<BindingSearchPattern>,
  literal_patterns: Vec<BindingSearchPattern>,
  regex_options: Option<BindingSearchOptions>,
  custom_regex_options: Option<BindingSearchOptions>,
  literal_options: Option<BindingSearchOptions>,
  literal_patterns_from_deny_list_data: bool,
  allowed_labels: Vec<String>,
  threshold: f64,
  confidence_boost: bool,
  slices: BindingPreparedSearchSlices,
  regex_meta: Vec<BindingRegexMatchMeta>,
  custom_regex_meta: Vec<BindingRegexMatchMeta>,
  deny_list_data: Option<BindingDenyListMatchData>,
  false_positive_filters: Option<BindingDenyListFilterData>,
  gazetteer_data: Option<BindingGazetteerMatchData>,
  country_data: Option<BindingCountryMatchData>,
  hotword_data: Option<BindingHotwordRuleData>,
  trigger_data: Option<BinaryTriggerData>,
  legal_form_data: Option<BindingLegalFormData>,
  address_seed_data: Option<BindingAddressSeedData>,
  zone_data: Option<BindingZoneData>,
  address_context_data: Option<BindingAddressContextData>,
  coreference_data: Option<BindingCoreferenceData>,
  name_corpus_data: Option<BindingNameCorpusData>,
  date_data: Option<BindingDateData>,
  monetary_data: Option<BindingMonetaryData>,
}

#[derive(Deserialize, Serialize)]
struct BinaryTriggerData {
  rules: Vec<BinaryTriggerRule>,
  address_stop_keywords: Vec<String>,
  party_position_terms: Vec<String>,
  #[serde(default)]
  post_nominals: Vec<String>,
  sentence_terminal_currency_terms: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct BinaryTriggerRule {
  trigger: String,
  label: String,
  strategy: BinaryTriggerStrategy,
  validations: Vec<BinaryTriggerValidation>,
  include_trigger: bool,
}

#[derive(Deserialize, Serialize)]
enum BinaryTriggerStrategy {
  ToNextComma {
    stop_words: Vec<String>,
    max_length: Option<u32>,
  },
  ToEndOfLine,
  NWords {
    count: u32,
  },
  CompanyIdValue,
  Address {
    max_chars: Option<u32>,
  },
  MatchPattern {
    pattern: String,
    flags: Option<String>,
  },
}

#[derive(Deserialize, Serialize)]
enum BinaryTriggerValidation {
  StartsUppercase,
  MinLength {
    min: u32,
  },
  MaxLength {
    max: u32,
  },
  NoDigits,
  HasDigits,
  MatchesPattern {
    pattern: String,
    flags: Option<String>,
  },
  ValidId {
    validator: String,
  },
}

pub fn prepared_search_package_to_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload = prepared_search_package_payload_to_bytes(config, artifacts)?;
  Ok(prepared_search_package_raw_payload_to_bytes(
    PREPARED_SEARCH_PACKAGE_HEADER,
    PREPARED_SEARCH_PACKAGE_VERSION,
    &payload,
  ))
}

pub fn prepared_search_package_to_compressed_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload = prepared_search_package_payload_to_bytes(config, artifacts)?;
  prepared_search_package_compress_payload(
    PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
    &payload,
  )
}

pub fn prepared_search_core_package_to_bytes(
  config: &PreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload =
    prepared_search_core_package_payload_to_bytes(config, artifacts)?;
  Ok(prepared_search_package_raw_payload_to_bytes(
    PREPARED_SEARCH_CORE_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_PACKAGE_VERSION,
    &payload,
  ))
}

pub fn prepared_search_core_package_to_compressed_bytes(
  config: &PreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload =
    prepared_search_core_package_payload_to_bytes(config, artifacts)?;
  prepared_search_package_compress_payload(
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
    &payload,
  )
}

#[must_use]
pub fn prepared_search_package_has_core_payload(bytes: &[u8]) -> bool {
  bytes
    .get(..PREPARED_SEARCH_CORE_PACKAGE_HEADER.len())
    .is_some_and(|header| {
      header == PREPARED_SEARCH_CORE_PACKAGE_HEADER
        || header == PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER
    })
}

pub fn prepared_search_package_digest(bytes: &[u8]) -> Result<[u8; 32]> {
  let parts = prepared_search_package_parts(bytes)?;
  let digest = parts.digest();
  let payload = parts.into_payload()?;
  verify_prepared_search_package_digest(digest, payload.as_ref())?;
  Ok(digest)
}

pub fn prepared_search_package_from_bytes(
  bytes: &[u8],
) -> Result<BindingPreparedSearchPackage> {
  let parts = prepared_search_package_parts(bytes)?;
  if parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a binding payload",
    ));
  }
  let digest = parts.digest();
  let payload = parts.into_payload()?;
  verify_prepared_search_package_digest(digest, payload.as_ref())?;
  let (package, read) = bincode::serde::decode_from_slice::<
    BinaryPreparedSearchPackageOwned,
    _,
  >(payload.as_ref(), package_bincode_config())
  .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  if read != payload.as_ref().len() {
    return Err(invalid_prepared_search_package("trailing payload data"));
  }
  Ok(BindingPreparedSearchPackage {
    config: BindingPreparedSearchConfig::from(package.config),
    artifacts: package.artifacts,
  })
}

pub fn prepared_search_core_package_from_bytes(
  bytes: &[u8],
) -> Result<CorePreparedSearchPackage> {
  let package = prepared_search_core_package_view_from_bytes(bytes)?;
  Ok(CorePreparedSearchPackage {
    config: package.config,
    artifacts: package.artifacts.into_owned(),
  })
}

pub fn prepared_search_core_package_view_from_bytes(
  bytes: &[u8],
) -> Result<CorePreparedSearchPackageView<'_>> {
  let parts = prepared_search_package_parts(bytes)?;
  if !parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a core payload",
    ));
  }
  let digest = parts.digest();
  let payload = parts.into_payload()?;
  verify_prepared_search_package_digest(digest, payload.as_ref())?;
  core_package_view_from_payload(payload)
}

impl From<BindingPreparedSearchConfig> for BinaryPreparedSearchConfig {
  fn from(config: BindingPreparedSearchConfig) -> Self {
    Self {
      regex_patterns: config.regex_patterns,
      custom_regex_patterns: config.custom_regex_patterns,
      literal_patterns: config.literal_patterns,
      regex_options: config.regex_options,
      custom_regex_options: config.custom_regex_options,
      literal_options: config.literal_options,
      literal_patterns_from_deny_list_data: config
        .literal_patterns_from_deny_list_data,
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      false_positive_filters: config.false_positive_filters,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
      hotword_data: config.hotword_data,
      trigger_data: config.trigger_data.map(BinaryTriggerData::from),
      legal_form_data: config.legal_form_data,
      address_seed_data: config.address_seed_data,
      zone_data: config.zone_data,
      address_context_data: config.address_context_data,
      coreference_data: config.coreference_data,
      name_corpus_data: config.name_corpus_data,
      date_data: config.date_data,
      monetary_data: config.monetary_data,
    }
  }
}

impl From<BinaryPreparedSearchConfig> for BindingPreparedSearchConfig {
  fn from(config: BinaryPreparedSearchConfig) -> Self {
    Self {
      regex_patterns: config.regex_patterns,
      custom_regex_patterns: config.custom_regex_patterns,
      literal_patterns: config.literal_patterns,
      regex_options: config.regex_options,
      custom_regex_options: config.custom_regex_options,
      literal_options: config.literal_options,
      literal_patterns_from_deny_list_data: config
        .literal_patterns_from_deny_list_data,
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
      slices: config.slices,
      regex_meta: config.regex_meta,
      custom_regex_meta: config.custom_regex_meta,
      deny_list_data: config.deny_list_data,
      false_positive_filters: config.false_positive_filters,
      gazetteer_data: config.gazetteer_data,
      country_data: config.country_data,
      hotword_data: config.hotword_data,
      trigger_data: config.trigger_data.map(BindingTriggerData::from),
      legal_form_data: config.legal_form_data,
      address_seed_data: config.address_seed_data,
      zone_data: config.zone_data,
      address_context_data: config.address_context_data,
      coreference_data: config.coreference_data,
      name_corpus_data: config.name_corpus_data,
      date_data: config.date_data,
      monetary_data: config.monetary_data,
    }
  }
}

impl From<BindingTriggerData> for BinaryTriggerData {
  fn from(data: BindingTriggerData) -> Self {
    Self {
      rules: data
        .rules
        .into_iter()
        .map(BinaryTriggerRule::from)
        .collect(),
      address_stop_keywords: data.address_stop_keywords,
      party_position_terms: data.party_position_terms,
      post_nominals: data.post_nominals,
      sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
    }
  }
}

impl From<BinaryTriggerData> for BindingTriggerData {
  fn from(data: BinaryTriggerData) -> Self {
    Self {
      rules: data
        .rules
        .into_iter()
        .map(BindingTriggerRule::from)
        .collect(),
      address_stop_keywords: data.address_stop_keywords,
      party_position_terms: data.party_position_terms,
      post_nominals: data.post_nominals,
      sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
    }
  }
}

impl From<BindingTriggerRule> for BinaryTriggerRule {
  fn from(rule: BindingTriggerRule) -> Self {
    Self {
      trigger: rule.trigger,
      label: rule.label,
      strategy: BinaryTriggerStrategy::from(rule.strategy),
      validations: rule
        .validations
        .into_iter()
        .map(BinaryTriggerValidation::from)
        .collect(),
      include_trigger: rule.include_trigger,
    }
  }
}

impl From<BinaryTriggerRule> for BindingTriggerRule {
  fn from(rule: BinaryTriggerRule) -> Self {
    Self {
      trigger: rule.trigger,
      label: rule.label,
      strategy: BindingTriggerStrategy::from(rule.strategy),
      validations: rule
        .validations
        .into_iter()
        .map(BindingTriggerValidation::from)
        .collect(),
      include_trigger: rule.include_trigger,
    }
  }
}

impl From<BindingTriggerStrategy> for BinaryTriggerStrategy {
  fn from(strategy: BindingTriggerStrategy) -> Self {
    match strategy {
      BindingTriggerStrategy::ToNextComma {
        stop_words,
        max_length,
      } => Self::ToNextComma {
        stop_words,
        max_length,
      },
      BindingTriggerStrategy::ToEndOfLine => Self::ToEndOfLine,
      BindingTriggerStrategy::NWords { count } => Self::NWords { count },
      BindingTriggerStrategy::CompanyIdValue => Self::CompanyIdValue,
      BindingTriggerStrategy::Address { max_chars } => {
        Self::Address { max_chars }
      }
      BindingTriggerStrategy::MatchPattern { pattern, flags } => {
        Self::MatchPattern { pattern, flags }
      }
    }
  }
}

impl From<BinaryTriggerStrategy> for BindingTriggerStrategy {
  fn from(strategy: BinaryTriggerStrategy) -> Self {
    match strategy {
      BinaryTriggerStrategy::ToNextComma {
        stop_words,
        max_length,
      } => Self::ToNextComma {
        stop_words,
        max_length,
      },
      BinaryTriggerStrategy::ToEndOfLine => Self::ToEndOfLine,
      BinaryTriggerStrategy::NWords { count } => Self::NWords { count },
      BinaryTriggerStrategy::CompanyIdValue => Self::CompanyIdValue,
      BinaryTriggerStrategy::Address { max_chars } => {
        Self::Address { max_chars }
      }
      BinaryTriggerStrategy::MatchPattern { pattern, flags } => {
        Self::MatchPattern { pattern, flags }
      }
    }
  }
}

impl From<BindingTriggerValidation> for BinaryTriggerValidation {
  fn from(validation: BindingTriggerValidation) -> Self {
    match validation {
      BindingTriggerValidation::StartsUppercase => Self::StartsUppercase,
      BindingTriggerValidation::MinLength { min } => Self::MinLength { min },
      BindingTriggerValidation::MaxLength { max } => Self::MaxLength { max },
      BindingTriggerValidation::NoDigits => Self::NoDigits,
      BindingTriggerValidation::HasDigits => Self::HasDigits,
      BindingTriggerValidation::MatchesPattern { pattern, flags } => {
        Self::MatchesPattern { pattern, flags }
      }
      BindingTriggerValidation::ValidId { validator } => {
        Self::ValidId { validator }
      }
    }
  }
}

impl From<BinaryTriggerValidation> for BindingTriggerValidation {
  fn from(validation: BinaryTriggerValidation) -> Self {
    match validation {
      BinaryTriggerValidation::StartsUppercase => Self::StartsUppercase,
      BinaryTriggerValidation::MinLength { min } => Self::MinLength { min },
      BinaryTriggerValidation::MaxLength { max } => Self::MaxLength { max },
      BinaryTriggerValidation::NoDigits => Self::NoDigits,
      BinaryTriggerValidation::HasDigits => Self::HasDigits,
      BinaryTriggerValidation::MatchesPattern { pattern, flags } => {
        Self::MatchesPattern { pattern, flags }
      }
      BinaryTriggerValidation::ValidId { validator } => {
        Self::ValidId { validator }
      }
    }
  }
}

fn prepared_search_package_payload_to_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  bincode::serde::encode_to_vec(
    BinaryPreparedSearchPackageRef {
      config: BinaryPreparedSearchConfig::from(config.clone()),
      artifacts,
    },
    package_bincode_config(),
  )
  .map_err(|error| invalid_prepared_search_package(error.to_string()))
}

fn prepared_search_core_package_payload_to_bytes(
  config: &PreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let mut config = config.clone();
  if core_literal_patterns_are_identity_mapped(&config) {
    config.literal_patterns.clear();
  }
  let config_bytes =
    bincode::serde::encode_to_vec(config, package_bincode_config())
      .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  let config_len = u64::try_from(config_bytes.len()).map_err(|_| {
    invalid_prepared_search_package("core config length overflow")
  })?;
  let mut bytes = Vec::with_capacity(
    std::mem::size_of::<u64>()
      .saturating_add(config_bytes.len())
      .saturating_add(artifacts.len()),
  );
  bytes.extend_from_slice(&config_len.to_le_bytes());
  bytes.extend_from_slice(&config_bytes);
  bytes.extend_from_slice(artifacts);
  Ok(bytes)
}

fn core_package_view_from_payload(
  payload: Cow<'_, [u8]>,
) -> Result<CorePreparedSearchPackageView<'_>> {
  let len_end = std::mem::size_of::<u64>();
  let len_bytes = payload.as_ref().get(..len_end).ok_or_else(|| {
    invalid_prepared_search_package("truncated config length")
  })?;
  let len_array = <[u8; 8]>::try_from(len_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed config length"))?;
  let config_len = usize::try_from(u64::from_le_bytes(len_array))
    .map_err(|_| invalid_prepared_search_package("config length overflow"))?;
  let config_end = len_end
    .checked_add(config_len)
    .ok_or_else(|| invalid_prepared_search_package("config length overflow"))?;
  let config_bytes = payload
    .as_ref()
    .get(len_end..config_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated config"))?;
  let (config, read) = bincode::serde::decode_from_slice::<
    PreparedSearchConfig,
    _,
  >(config_bytes, package_bincode_config())
  .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  if read != config_bytes.len() {
    return Err(invalid_prepared_search_package("trailing config data"));
  }

  let artifacts = match payload {
    Cow::Borrowed(bytes) => Cow::Borrowed(
      bytes
        .get(config_end..)
        .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?,
    ),
    Cow::Owned(bytes) => Cow::Owned(
      bytes
        .get(config_end..)
        .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?
        .to_vec(),
    ),
  };

  Ok(CorePreparedSearchPackageView { config, artifacts })
}

fn core_literal_patterns_are_identity_mapped(
  config: &PreparedSearchConfig,
) -> bool {
  !config.literal_patterns.is_empty()
    && config
      .literal_patterns
      .iter()
      .all(|pattern| matches!(pattern, SearchPattern::Literal(_)))
}

fn prepared_search_package_raw_payload_to_bytes(
  header: [u8; 8],
  version: u32,
  payload: &[u8],
) -> Vec<u8> {
  let digest = blake3::hash(payload);
  let mut bytes = Vec::with_capacity(raw_package_header_len(payload));
  write_package_header(&mut bytes, header, version, digest.as_bytes());
  bytes.extend_from_slice(payload);
  bytes
}

fn prepared_search_package_compress_payload(
  header: [u8; 8],
  version: u32,
  payload: &[u8],
) -> Result<Vec<u8>> {
  let compressed =
    zstd::bulk::compress(payload, PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL)
      .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  let digest = blake3::hash(payload);
  let mut bytes = Vec::with_capacity(
    raw_package_header_len(&compressed)
      .saturating_add(std::mem::size_of::<u64>()),
  );
  write_package_header(&mut bytes, header, version, digest.as_bytes());
  let payload_len = u64::try_from(payload.len())
    .map_err(|_| invalid_prepared_search_package("payload length overflow"))?;
  bytes.extend_from_slice(&payload_len.to_le_bytes());
  bytes.extend_from_slice(&compressed);
  Ok(bytes)
}

const fn raw_package_header_len(payload: &[u8]) -> usize {
  PREPARED_SEARCH_PACKAGE_HEADER
    .len()
    .saturating_add(std::mem::size_of::<u32>())
    .saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES)
    .saturating_add(payload.len())
}

fn write_package_header(
  bytes: &mut Vec<u8>,
  header: [u8; 8],
  version: u32,
  digest: &[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
) {
  bytes.extend_from_slice(&header);
  bytes.extend_from_slice(&version.to_le_bytes());
  bytes.extend_from_slice(digest);
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingOperatorConfig {
  pub operators: Option<BTreeMap<String, String>>,
  #[serde(default, alias = "redactString")]
  pub redact_string: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingRedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingOperatorEntry {
  pub placeholder: String,
  pub operator: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingRedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<BindingRedactionEntry>,
  pub operator_map: Vec<BindingOperatorEntry>,
  pub entity_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingPipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: String,
  pub source_detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionResult {
  pub resolved_entities: Vec<BindingPipelineEntity>,
  pub redaction: BindingRedactionResult,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingDiagnosticEvent {
  pub stage: String,
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub engine: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pattern: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_detail: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub start: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub end: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub score: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub span_valid: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub elapsed_us: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub input_bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionDiagnostics {
  pub events: Vec<BindingDiagnosticEvent>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionDiagnosticResult {
  pub result: BindingStaticRedactionResult,
  pub diagnostics: BindingStaticRedactionDiagnostics,
}

pub fn prepared_search_config_from_binding(
  config: BindingPreparedSearchConfig,
) -> Result<PreparedSearchConfig> {
  let deny_list_data = config.deny_list_data;
  let literal_patterns = literal_patterns_from_binding(
    config.literal_patterns,
    config.literal_patterns_from_deny_list_data,
    deny_list_data.as_ref(),
  )?;
  let legal_form_data = config.legal_form_data.map(|data| LegalFormData {
    suffixes: data.suffixes,
    normalized_boundary_suffixes: data.normalized_boundary_suffixes,
    normalized_in_name_words: data.normalized_in_name_words,
    normalized_suffix_words: data.normalized_suffix_words,
    role_heads: data.role_heads,
    sentence_verb_indicators: data.sentence_verb_indicators,
    clause_noun_heads: data.clause_noun_heads,
    connector_prose_heads: data.connector_prose_heads,
    structural_single_cap_prefixes: data.structural_single_cap_prefixes,
    leading_clause_phrases: data.leading_clause_phrases,
    leading_clause_direct_prefixes: data.leading_clause_direct_prefixes,
    connector_words: data.connector_words,
    and_connector_words: data.and_connector_words,
    in_name_prepositions: data.in_name_prepositions,
    company_suffix_words: data.company_suffix_words,
    comma_gated_direct_prefixes: data.comma_gated_direct_prefixes,
  });
  let legal_form_suffixes = legal_form_data
    .as_ref()
    .map_or_else(Vec::new, |data| data.suffixes.clone());
  Ok(PreparedSearchConfig {
    regex_patterns: search_patterns_from_binding(config.regex_patterns)?,
    custom_regex_patterns: search_patterns_from_binding(
      config.custom_regex_patterns,
    )?,
    literal_patterns,
    regex_options: search_options_from_binding(config.regex_options),
    custom_regex_options: search_options_from_binding(
      config.custom_regex_options,
    ),
    literal_options: search_options_from_binding(config.literal_options),
    allowed_labels: config.allowed_labels,
    threshold: config.threshold,
    confidence_boost: config.confidence_boost,
    slices: slices_from_binding(&config.slices),
    regex_meta: regex_meta_from_binding(config.regex_meta)?,
    custom_regex_meta: regex_meta_from_binding(config.custom_regex_meta)?,
    deny_list_data: deny_list_data
      .map(deny_list_data_from_binding)
      .transpose()?,
    false_positive_filters: config
      .false_positive_filters
      .map(deny_list_filters_from_binding),
    gazetteer_data: config.gazetteer_data.map(|data| GazetteerMatchData {
      labels: data.labels,
      is_fuzzy: data.is_fuzzy,
    }),
    country_data: config.country_data.map(|data| CountryMatchData {
      labels: data.labels,
    }),
    hotword_data: config.hotword_data.map(hotword_data_from_binding),
    trigger_data: config
      .trigger_data
      .map(|data| trigger_data_from_binding(data, legal_form_suffixes)),
    legal_form_data,
    address_seed_data: config.address_seed_data.map(|data| AddressSeedData {
      boundary_words: data.boundary_words,
      br_cep_cue_words: data.br_cep_cue_words,
      unit_abbreviations: data.unit_abbreviations,
    }),
    zone_data: config.zone_data.map(zone_data_from_binding),
    address_context_data: config.address_context_data.map(|data| {
      AddressContextData {
        address_prepositions: data.address_prepositions,
        temporal_prepositions: data.temporal_prepositions,
        street_abbreviations: data.street_abbreviations,
        bare_house_stopwords: data.bare_house_stopwords,
      }
    }),
    coreference_data: config
      .coreference_data
      .map(coreference_data_from_binding),
    name_corpus_data: config
      .name_corpus_data
      .map(name_corpus_data_from_binding),
    date_data: config.date_data.map(|data| DateData {
      month_names_by_language: data.month_names_by_language,
      year_words_by_language: data.year_words_by_language,
    }),
    monetary_data: config.monetary_data.map(monetary_data_from_binding),
  })
}

enum PreparedSearchPackageParts<'a> {
  Raw {
    core: bool,
    digest: [u8; 32],
    payload: &'a [u8],
  },
  Compressed {
    core: bool,
    digest: [u8; 32],
    uncompressed_len: usize,
    payload: &'a [u8],
  },
}

impl<'a> PreparedSearchPackageParts<'a> {
  const fn digest(&self) -> [u8; 32] {
    match self {
      Self::Raw { digest, .. } | Self::Compressed { digest, .. } => *digest,
    }
  }

  const fn is_core(&self) -> bool {
    match self {
      Self::Raw { core, .. } | Self::Compressed { core, .. } => *core,
    }
  }

  fn into_payload(self) -> Result<Cow<'a, [u8]>> {
    match self {
      Self::Raw { payload, .. } => Ok(Cow::Borrowed(payload)),
      Self::Compressed {
        uncompressed_len,
        payload,
        ..
      } => {
        if uncompressed_len > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "uncompressed payload length exceeds limit",
          ));
        }
        zstd::bulk::decompress(payload, uncompressed_len)
          .map(Cow::Owned)
          .map_err(|error| invalid_prepared_search_package(error.to_string()))
      }
    }
  }
}

struct RawPackageHeader<'a> {
  digest: [u8; 32],
  payload: &'a [u8],
}

fn prepared_search_package_parts(
  bytes: &[u8],
) -> Result<PreparedSearchPackageParts<'_>> {
  let header = bytes
    .get(..PREPARED_SEARCH_PACKAGE_HEADER.len())
    .ok_or_else(|| invalid_prepared_search_package("truncated header"))?;
  if header == PREPARED_SEARCH_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      PREPARED_SEARCH_PACKAGE_VERSION,
      PREPARED_SEARCH_PACKAGE_HEADER.len(),
    )?;
    return Ok(PreparedSearchPackageParts::Raw {
      core: false,
      digest: raw.digest,
      payload: raw.payload,
    });
  }
  if header == PREPARED_SEARCH_CORE_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      PREPARED_SEARCH_CORE_PACKAGE_VERSION,
      PREPARED_SEARCH_CORE_PACKAGE_HEADER.len(),
    )?;
    return Ok(PreparedSearchPackageParts::Raw {
      core: true,
      digest: raw.digest,
      payload: raw.payload,
    });
  }
  if header == PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    let len_end = std::mem::size_of::<u64>();
    let len_bytes = raw
      .payload
      .get(..len_end)
      .ok_or_else(|| invalid_prepared_search_package("truncated length"))?;
    let len_array = <[u8; 8]>::try_from(len_bytes)
      .map_err(|_| invalid_prepared_search_package("malformed length"))?;
    let uncompressed_len = usize::try_from(u64::from_le_bytes(len_array))
      .map_err(|_| invalid_prepared_search_package("length overflow"))?;
    let payload = raw
      .payload
      .get(len_end..)
      .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
    return Ok(PreparedSearchPackageParts::Compressed {
      core: false,
      digest: raw.digest,
      uncompressed_len,
      payload,
    });
  }
  if header == PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    let len_end = std::mem::size_of::<u64>();
    let len_bytes = raw
      .payload
      .get(..len_end)
      .ok_or_else(|| invalid_prepared_search_package("truncated length"))?;
    let len_array = <[u8; 8]>::try_from(len_bytes)
      .map_err(|_| invalid_prepared_search_package("malformed length"))?;
    let uncompressed_len = usize::try_from(u64::from_le_bytes(len_array))
      .map_err(|_| invalid_prepared_search_package("length overflow"))?;
    let payload = raw
      .payload
      .get(len_end..)
      .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
    return Ok(PreparedSearchPackageParts::Compressed {
      core: true,
      digest: raw.digest,
      uncompressed_len,
      payload,
    });
  }
  Err(invalid_prepared_search_package("unexpected header"))
}

fn raw_package_header(
  bytes: &[u8],
  expected_version: u32,
  header_len: usize,
) -> Result<RawPackageHeader<'_>> {
  let version_start = header_len;
  let version_end = version_start.saturating_add(std::mem::size_of::<u32>());
  let version_bytes = bytes
    .get(version_start..version_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated version"))?;
  let version_array = <[u8; 4]>::try_from(version_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed version"))?;
  let version = u32::from_le_bytes(version_array);
  if version != expected_version {
    return Err(invalid_prepared_search_package("unsupported version"));
  }
  let digest_end =
    version_end.saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES);
  let digest_bytes = bytes
    .get(version_end..digest_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated digest"))?;
  let digest =
    <[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES]>::try_from(digest_bytes)
      .map_err(|_| invalid_prepared_search_package("malformed digest"))?;
  let payload = bytes
    .get(digest_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
  Ok(RawPackageHeader { digest, payload })
}

fn verify_prepared_search_package_digest(
  expected: [u8; 32],
  payload: &[u8],
) -> Result<()> {
  let actual = blake3::hash(payload);
  if actual.as_bytes() != &expected {
    return Err(invalid_prepared_search_package("digest mismatch"));
  }
  Ok(())
}

fn package_bincode_config() -> impl bincode::config::Config {
  bincode::config::standard()
    .with_little_endian()
    .with_variable_int_encoding()
}

fn invalid_prepared_search_package(reason: impl Into<String>) -> ContractError {
  ContractError::InvalidPreparedSearchPackage {
    reason: reason.into(),
  }
}

fn deny_list_data_from_binding(
  data: BindingDenyListMatchData,
) -> Result<DenyListMatchData> {
  let pattern_count = data.originals.len();
  Ok(DenyListMatchData {
    labels: string_groups_from_binding(
      data.labels,
      data.label_indices,
      data.label_table.clone(),
      pattern_count,
      "deny_list.label_indices",
    )?,
    custom_labels: string_groups_from_binding(
      data.custom_labels,
      data.custom_label_indices,
      data.label_table,
      pattern_count,
      "deny_list.custom_label_indices",
    )?,
    originals: data.originals,
    sources: string_groups_from_binding(
      data.sources,
      data.source_indices,
      data.source_table,
      pattern_count,
      "deny_list.source_indices",
    )?,
    filters: data.filters.map(deny_list_filters_from_binding),
  })
}

fn string_groups_from_binding(
  groups: Vec<Vec<String>>,
  indices: Vec<Vec<u32>>,
  table: Vec<String>,
  pattern_count: usize,
  field: &'static str,
) -> Result<StringGroups> {
  if !indices.is_empty() {
    validate_compact_string_indices(&indices, &table, field)?;
    return StringGroups::from_table_indices(table, indices, field).map_err(
      |error| ContractError::InvalidCompactStringGroups {
        field,
        reason: error.to_string(),
      },
    );
  }

  if !groups.is_empty() {
    return Ok(StringGroups::from_groups(groups));
  }

  Ok(StringGroups::empty_groups(pattern_count))
}

fn validate_compact_string_indices(
  groups: &[Vec<u32>],
  table: &[String],
  field: &'static str,
) -> Result<()> {
  for group in groups {
    for &index in group {
      let Ok(index_usize) = usize::try_from(index) else {
        return Err(ContractError::CompactStringIndexOutOfRange {
          field,
          index,
        });
      };
      if index_usize >= table.len() {
        return Err(ContractError::CompactStringIndexOutOfRange {
          field,
          index,
        });
      }
    }
  }

  Ok(())
}

fn monetary_data_from_binding(data: BindingMonetaryData) -> MonetaryData {
  MonetaryData {
    currencies: CurrencyData {
      codes: data.currencies.codes,
      symbols: data.currencies.symbols,
      local_names: data.currencies.local_names,
    },
    amount_words: AmountWordsData {
      written_amount_patterns: data
        .amount_words
        .written_amount_patterns
        .into_iter()
        .map(|entry| WrittenAmountPatternData {
          keywords: entry.keywords,
        })
        .collect(),
      magnitude_suffixes: data
        .amount_words
        .magnitude_suffixes
        .into_iter()
        .map(|entry| MagnitudeSuffixData {
          words: entry.words,
          abbreviations_case_insensitive: entry.abbreviations_case_insensitive,
          abbreviations_case_sensitive: entry.abbreviations_case_sensitive,
        })
        .collect(),
      share_quantity_terms: data
        .amount_words
        .share_quantity_terms
        .into_iter()
        .map(|entry| ShareQuantityTermData {
          modifiers: entry.modifiers,
          nouns: entry.nouns,
        })
        .collect(),
    },
  }
}

fn hotword_data_from_binding(data: BindingHotwordRuleData) -> HotwordRuleData {
  HotwordRuleData {
    rules: data
      .rules
      .into_iter()
      .map(|rule| HotwordRule {
        hotwords: rule.hotwords,
        target_labels: rule.target_labels,
        score_adjustment: rule.score_adjustment,
        reclassify_to: rule.reclassify_to,
        proximity_before: rule.proximity_before,
        proximity_after: rule.proximity_after,
      })
      .collect(),
    pattern_rule_indices: data.pattern_rule_indices,
  }
}

fn coreference_data_from_binding(
  data: BindingCoreferenceData,
) -> CoreferenceData {
  CoreferenceData {
    definition_patterns: data
      .definition_patterns
      .into_iter()
      .map(|pattern| CoreferencePatternData {
        pattern: pattern.pattern,
        flags: pattern.flags,
      })
      .collect(),
    role_stop_terms: data.role_stop_terms,
    legal_form_aliases: data.legal_form_aliases,
    organization_determiners: data.organization_determiners,
  }
}

fn name_corpus_data_from_binding(
  data: BindingNameCorpusData,
) -> NameCorpusData {
  NameCorpusData {
    first_names: data.first_names,
    surnames: data.surnames,
    title_tokens: data.title_tokens,
    title_abbreviations: data.title_abbreviations,
    excluded_words: data.excluded_words,
    common_words: data.common_words,
    non_western_names: data.non_western_names,
    excluded_all_caps: data.excluded_all_caps,
    ja_suffixes: data.ja_suffixes,
    arabic_connectors: data.arabic_connectors,
    relation_connectors: data.relation_connectors,
    hyphenated_prefixes: data.hyphenated_prefixes,
    cjk_non_person_terms: data.cjk_non_person_terms,
    cjk_surname_starters: data.cjk_surname_starters,
    organization_terms: data.organization_terms,
  }
}

fn zone_data_from_binding(data: BindingZoneData) -> ZoneData {
  ZoneData {
    section_heading_patterns: data
      .section_heading_patterns
      .into_iter()
      .map(|pattern| ZonePatternData {
        pattern: pattern.pattern,
        flags: pattern.flags,
      })
      .collect(),
    signing_clauses: data
      .signing_clauses
      .into_iter()
      .map(|clause| ZoneSigningClauseData {
        prefix: clause.prefix,
        suffix: clause.suffix,
        prepositions: clause.prepositions,
      })
      .collect(),
  }
}

pub fn operator_config_from_binding(
  config: Option<BindingOperatorConfig>,
) -> Result<OperatorConfig> {
  let Some(config) = config else {
    return Ok(OperatorConfig::default());
  };

  let mut operators = BTreeMap::new();
  for (label, value) in config.operators.unwrap_or_default() {
    operators.insert(label, operator_type_from_binding(&value)?);
  }

  Ok(OperatorConfig {
    operators,
    redact_string: config
      .redact_string
      .unwrap_or_else(|| String::from("[REDACTED]")),
  })
}

#[must_use]
pub fn static_redaction_result_to_binding(
  result: StaticRedactionResult,
) -> BindingStaticRedactionResult {
  BindingStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| BindingPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: detection_source_name(entity.source),
        source_detail: entity.source_detail.map(source_detail_name),
      })
      .collect(),
    redaction: BindingRedactionResult {
      redacted_text: result.redaction.redacted_text,
      redaction_map: result
        .redaction
        .redaction_map
        .into_iter()
        .map(|entry| BindingRedactionEntry {
          placeholder: entry.placeholder,
          original: entry.original,
        })
        .collect(),
      operator_map: result
        .redaction
        .operator_map
        .into_iter()
        .map(|entry| BindingOperatorEntry {
          placeholder: entry.placeholder,
          operator: operator_name(entry.operator),
        })
        .collect(),
      entity_count: result.redaction.entity_count,
    },
  }
}

pub fn static_redaction_result_to_utf16_binding(
  result: StaticRedactionResult,
  full_text: &str,
) -> Result<BindingStaticRedactionResult> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut result = static_redaction_result_to_binding(result);
  convert_pipeline_entity_offsets(&mut result.resolved_entities, &offsets)?;
  Ok(result)
}

#[must_use]
pub fn static_redaction_diagnostic_result_to_binding(
  result: StaticRedactionDiagnosticResult,
) -> BindingStaticRedactionDiagnosticResult {
  BindingStaticRedactionDiagnosticResult {
    result: static_redaction_result_to_binding(result.result),
    diagnostics: static_redaction_diagnostics_to_binding(result.diagnostics),
  }
}

pub fn static_redaction_diagnostic_result_to_utf16_binding(
  result: StaticRedactionDiagnosticResult,
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnosticResult> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut result = static_redaction_diagnostic_result_to_binding(result);
  convert_pipeline_entity_offsets(
    &mut result.result.resolved_entities,
    &offsets,
  )?;
  convert_diagnostic_offsets(&mut result.diagnostics.events, &offsets)?;
  Ok(result)
}

#[must_use]
pub fn static_redaction_diagnostics_to_binding(
  diagnostics: StaticRedactionDiagnostics,
) -> BindingStaticRedactionDiagnostics {
  BindingStaticRedactionDiagnostics {
    events: diagnostics
      .events
      .into_iter()
      .map(diagnostic_event_to_binding)
      .collect(),
  }
}

pub fn static_redaction_diagnostics_to_utf16_binding(
  diagnostics: StaticRedactionDiagnostics,
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnostics> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut diagnostics = static_redaction_diagnostics_to_binding(diagnostics);
  convert_diagnostic_offsets(&mut diagnostics.events, &offsets)?;
  Ok(diagnostics)
}

fn diagnostic_event_to_binding(
  event: DiagnosticEvent,
) -> BindingDiagnosticEvent {
  BindingDiagnosticEvent {
    stage: diagnostic_stage_name(event.stage),
    kind: diagnostic_event_kind_name(event.kind),
    count: event.count,
    engine: event.engine.map(search_engine_name),
    pattern: event.pattern,
    source: event.source.map(detection_source_name),
    source_detail: event.source_detail.map(source_detail_name),
    label: event.label,
    start: event.start,
    end: event.end,
    text: event.text,
    score: event.score,
    span_valid: event.span_valid,
    elapsed_us: event.elapsed_us,
    input_bytes: event.input_bytes,
    reason: event.reason,
  }
}

fn convert_pipeline_entity_offsets(
  entities: &mut [BindingPipelineEntity],
  offsets: &Utf16OffsetMap,
) -> Result<()> {
  for entity in entities {
    entity.start = offsets.convert(entity.start)?;
    entity.end = offsets.convert(entity.end)?;
  }
  Ok(())
}

fn convert_diagnostic_offsets(
  events: &mut [BindingDiagnosticEvent],
  offsets: &Utf16OffsetMap,
) -> Result<()> {
  for event in events {
    if let Some(start) = event.start {
      event.start = Some(offsets.convert(start)?);
    }
    if let Some(end) = event.end {
      event.end = Some(offsets.convert(end)?);
    }
  }
  Ok(())
}

struct Utf16OffsetMap {
  boundaries: Vec<(u32, u32)>,
}

impl Utf16OffsetMap {
  fn new(text: &str) -> Result<Self> {
    let mut boundaries = Vec::new();
    let mut utf16_offset = 0_u32;
    boundaries.push((0, 0));

    for (byte_start, ch) in text.char_indices() {
      utf16_offset = utf16_offset
        .checked_add(char_utf16_width(ch))
        .ok_or_else(|| ContractError::InvalidPreparedSearchPackage {
          reason: String::from("UTF-16 offset exceeds u32 range"),
        })?;
      let byte_end = byte_start.saturating_add(ch.len_utf8());
      boundaries.push((u32_from_usize(byte_end)?, utf16_offset));
    }

    Ok(Self { boundaries })
  }

  fn convert(&self, offset: u32) -> Result<u32> {
    self
      .try_convert(offset)
      .ok_or(ContractError::InvalidBindingOffset { offset })
  }

  fn try_convert(&self, offset: u32) -> Option<u32> {
    let index = self
      .boundaries
      .binary_search_by_key(&offset, |(byte_offset, _)| *byte_offset)
      .ok()?;
    self
      .boundaries
      .get(index)
      .map(|(_, utf16_offset)| *utf16_offset)
  }
}

const fn char_utf16_width(ch: char) -> u32 {
  if ch.len_utf16() == 1 { 1 } else { 2 }
}

fn u32_from_usize(value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| {
    ContractError::InvalidPreparedSearchPackage {
      reason: format!("Offset exceeds u32 range: {value}"),
    }
  })
}

fn deny_list_filters_from_binding(
  filters: BindingDenyListFilterData,
) -> DenyListFilterData {
  DenyListFilterData {
    stopwords: lower_set(filters.stopwords),
    allow_list: lower_set(filters.allow_list),
    person_stopwords: lower_set(filters.person_stopwords),
    person_trailing_nouns: lower_set(filters.person_trailing_nouns),
    address_stopwords: lower_set(filters.address_stopwords),
    address_jurisdiction_prefixes: lower_set(
      filters.address_jurisdiction_prefixes,
    ),
    street_types: lower_set(filters.street_types),
    address_component_terms: lower_set(filters.address_component_terms),
    ambiguous_street_type_terms: lower_set(filters.ambiguous_street_type_terms),
    first_names: lower_set(filters.first_names),
    generic_roles: lower_set(filters.generic_roles),
    number_abbrev_prefixes: lower_set(filters.number_abbrev_prefixes),
    sentence_starters: lower_set(filters.sentence_starters),
    trailing_address_word_exclusions: lower_set(
      filters.trailing_address_word_exclusions,
    ),
    document_heading_words: lower_set(filters.document_heading_words),
    document_heading_ordinal_markers: lower_set(
      filters.document_heading_ordinal_markers,
    ),
    defined_term_cues: lower_set(filters.defined_term_cues),
    signing_place_guards: filters
      .signing_place_guards
      .into_iter()
      .map(|guard| SigningPlaceGuardData {
        prefix_phrases: lower_set(guard.prefix_phrases),
        suffix_phrases: lower_set(guard.suffix_phrases),
      })
      .collect(),
  }
}

fn trigger_data_from_binding(
  data: BindingTriggerData,
  legal_form_suffixes: Vec<String>,
) -> TriggerData {
  TriggerData {
    rules: data
      .rules
      .into_iter()
      .map(trigger_rule_from_binding)
      .collect(),
    address_stop_keywords: data.address_stop_keywords,
    party_position_terms: data.party_position_terms,
    legal_form_suffixes,
    post_nominals: data.post_nominals,
    sentence_terminal_currency_terms: data.sentence_terminal_currency_terms,
  }
}

fn trigger_rule_from_binding(rule: BindingTriggerRule) -> TriggerRule {
  TriggerRule {
    trigger: rule.trigger,
    label: rule.label,
    strategy: trigger_strategy_from_binding(rule.strategy),
    validations: rule
      .validations
      .into_iter()
      .map(trigger_validation_from_binding)
      .collect(),
    include_trigger: rule.include_trigger,
  }
}

fn trigger_strategy_from_binding(
  strategy: BindingTriggerStrategy,
) -> TriggerStrategy {
  match strategy {
    BindingTriggerStrategy::ToNextComma {
      stop_words,
      max_length,
    } => TriggerStrategy::ToNextComma {
      stop_words,
      max_length,
    },
    BindingTriggerStrategy::ToEndOfLine => TriggerStrategy::ToEndOfLine,
    BindingTriggerStrategy::NWords { count } => {
      TriggerStrategy::NWords { count }
    }
    BindingTriggerStrategy::CompanyIdValue => TriggerStrategy::CompanyIdValue,
    BindingTriggerStrategy::Address { max_chars } => {
      TriggerStrategy::Address { max_chars }
    }
    BindingTriggerStrategy::MatchPattern { pattern, flags } => {
      TriggerStrategy::MatchPattern { pattern, flags }
    }
  }
}

fn trigger_validation_from_binding(
  validation: BindingTriggerValidation,
) -> TriggerValidation {
  match validation {
    BindingTriggerValidation::StartsUppercase => {
      TriggerValidation::StartsUppercase
    }
    BindingTriggerValidation::MinLength { min } => {
      TriggerValidation::MinLength(min)
    }
    BindingTriggerValidation::MaxLength { max } => {
      TriggerValidation::MaxLength(max)
    }
    BindingTriggerValidation::NoDigits => TriggerValidation::NoDigits,
    BindingTriggerValidation::HasDigits => TriggerValidation::HasDigits,
    BindingTriggerValidation::MatchesPattern { pattern, flags } => {
      TriggerValidation::MatchesPattern { pattern, flags }
    }
    BindingTriggerValidation::ValidId { validator } => {
      TriggerValidation::ValidId { validator }
    }
  }
}

fn lower_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn search_patterns_from_binding(
  patterns: Vec<BindingSearchPattern>,
) -> Result<Vec<SearchPattern>> {
  patterns
    .into_iter()
    .map(search_pattern_from_binding)
    .collect()
}

fn literal_patterns_from_binding(
  patterns: Vec<BindingSearchPattern>,
  from_deny_list_data: bool,
  deny_list_data: Option<&BindingDenyListMatchData>,
) -> Result<Vec<SearchPattern>> {
  let mut literal_patterns = search_patterns_from_binding(patterns)?;
  if !from_deny_list_data {
    return Ok(literal_patterns);
  }

  let Some(data) = deny_list_data else {
    return Err(ContractError::MissingDenyListDataForLiteralPatterns);
  };
  let mut from_data = Vec::with_capacity(
    data.originals.len().saturating_add(literal_patterns.len()),
  );
  from_data.extend(data.originals.iter().cloned().map(SearchPattern::Literal));
  from_data.append(&mut literal_patterns);
  Ok(from_data)
}

fn search_pattern_from_binding(
  pattern: BindingSearchPattern,
) -> Result<SearchPattern> {
  match pattern.kind.as_str() {
    "literal" => Ok(SearchPattern::Literal(pattern.pattern)),
    "literal-with-options" => Ok(SearchPattern::LiteralWithOptions {
      pattern: pattern.pattern,
      case_insensitive: pattern.case_insensitive,
      whole_words: pattern.whole_words,
    }),
    "regex" => {
      if pattern.lazy.is_some()
        || pattern.prefilter_any.is_some()
        || pattern.prefilter_case_insensitive.is_some()
        || pattern.prefilter_regex.is_some()
      {
        return Ok(SearchPattern::RegexWithOptions {
          pattern: pattern.pattern,
          lazy: pattern.lazy.unwrap_or(false),
          prefilter_any: pattern.prefilter_any.unwrap_or_default(),
          prefilter_case_insensitive: pattern.prefilter_case_insensitive,
          prefilter_regex: pattern.prefilter_regex,
        });
      }
      Ok(SearchPattern::Regex(pattern.pattern))
    }
    "fuzzy" => Ok(SearchPattern::Fuzzy {
      pattern: pattern.pattern,
      distance: pattern
        .distance
        .map(|distance| {
          u8::try_from(distance)
            .map_err(|_| ContractError::FuzzyDistanceOutOfRange { distance })
        })
        .transpose()?,
    }),
    _ => {
      Err(ContractError::UnsupportedSearchPatternKind { kind: pattern.kind })
    }
  }
}

fn search_options_from_binding(
  options: Option<BindingSearchOptions>,
) -> SearchOptions {
  let Some(options) = options else {
    return SearchOptions::default();
  };

  SearchOptions {
    literal: LiteralSearchOptions {
      case_insensitive: options.literal_case_insensitive.unwrap_or(false),
      whole_words: options.literal_whole_words.unwrap_or(false),
    },
    regex: RegexSearchOptions {
      whole_words: options.regex_whole_words.unwrap_or(false),
      overlap_all: options.regex_overlap_all.unwrap_or(false),
    },
    fuzzy: FuzzySearchOptions {
      case_insensitive: options.fuzzy_case_insensitive.unwrap_or(false),
      whole_words: options.fuzzy_whole_words.unwrap_or(true),
      normalize_diacritics: options.fuzzy_normalize_diacritics.unwrap_or(false),
    },
  }
}

fn slices_from_binding(
  slices: &BindingPreparedSearchSlices,
) -> PreparedSearchSlices {
  PreparedSearchSlices {
    regex: slice_from_binding(slices.regex),
    custom_regex: slice_from_binding(slices.custom_regex),
    legal_forms: slice_from_binding(slices.legal_forms),
    triggers: slice_from_binding(slices.triggers),
    deny_list: slice_from_binding(slices.deny_list),
    street_types: slice_from_binding(slices.street_types),
    gazetteer: slice_from_binding(slices.gazetteer),
    countries: slice_from_binding(slices.countries),
    hotwords: slice_from_binding(slices.hotwords),
  }
}

fn slice_from_binding(slice: Option<BindingPatternSlice>) -> PatternSlice {
  slice.map_or_else(PatternSlice::default, |slice| PatternSlice {
    start: slice.start,
    end: slice.end,
  })
}

fn regex_meta_from_binding(
  meta: Vec<BindingRegexMatchMeta>,
) -> Result<Vec<RegexMatchMeta>> {
  meta
    .into_iter()
    .map(|entry| {
      Ok(RegexMatchMeta {
        label: entry.label,
        score: entry.score,
        source_detail: entry
          .source_detail
          .map(|value| source_detail_from_binding(&value))
          .transpose()?,
        requires_validation: entry.requires_validation.unwrap_or(false),
        validator_id: entry.validator_id,
        validator_input: entry.validator_input,
        min_byte_length: entry.min_byte_length,
      })
    })
    .collect()
}

fn source_detail_from_binding(value: &str) -> Result<SourceDetail> {
  match value {
    "custom-deny-list" => Ok(SourceDetail::CustomDenyList),
    "custom-regex" => Ok(SourceDetail::CustomRegex),
    "gazetteer-extension" => Ok(SourceDetail::GazetteerExtension),
    "address-context" => Ok(SourceDetail::AddressContext),
    _ => Err(ContractError::UnsupportedSourceDetail {
      value: value.to_owned(),
    }),
  }
}

fn operator_type_from_binding(value: &str) -> Result<OperatorType> {
  match value {
    "replace" => Ok(OperatorType::Replace),
    "redact" => Ok(OperatorType::Redact),
    _ => Err(ContractError::UnsupportedOperator {
      value: value.to_owned(),
    }),
  }
}

fn detection_source_name(source: DetectionSource) -> String {
  match source {
    DetectionSource::Trigger => "trigger",
    DetectionSource::Regex => "regex",
    DetectionSource::DenyList => "deny-list",
    DetectionSource::LegalForm => "legal-form",
    DetectionSource::Gazetteer => "gazetteer",
    DetectionSource::Country => "country",
    DetectionSource::Ner => "ner",
    DetectionSource::Coreference => "coreference",
  }
  .to_owned()
}

fn source_detail_name(detail: SourceDetail) -> String {
  match detail {
    SourceDetail::CustomDenyList => "custom-deny-list",
    SourceDetail::CustomRegex => "custom-regex",
    SourceDetail::GazetteerExtension => "gazetteer-extension",
    SourceDetail::AddressContext => "address-context",
  }
  .to_owned()
}

fn search_engine_name(engine: SearchEngine) -> String {
  match engine {
    SearchEngine::Literal => "literal",
    SearchEngine::Regex => "regex",
    SearchEngine::Fuzzy => "fuzzy",
    SearchEngine::Text => "text-search",
  }
  .to_owned()
}

fn diagnostic_stage_name(stage: DiagnosticStage) -> String {
  match stage {
    DiagnosticStage::PrepareCacheHit => "prepare.cache.hit",
    DiagnosticStage::PrepareCacheMiss => "prepare.cache.miss",
    DiagnosticStage::PrepareBindingParse => "prepare.binding.parse",
    DiagnosticStage::PreparePackageDecode => "prepare.package.decode",
    DiagnosticStage::PrepareBindingConvert => "prepare.binding.convert",
    DiagnosticStage::PrepareArtifactsDecode => "prepare.artifacts.decode",
    DiagnosticStage::PrepareTotal => "prepare.total",
    DiagnosticStage::PrepareRegex => "prepare.regex",
    DiagnosticStage::PrepareCustomRegex => "prepare.custom-regex",
    DiagnosticStage::PrepareAnchored => "prepare.anchored",
    DiagnosticStage::PrepareLegalFormSearch => "prepare.legal-form-search",
    DiagnosticStage::PrepareTriggerSearch => "prepare.trigger-search",
    DiagnosticStage::PrepareLiteral => "prepare.literal",
    DiagnosticStage::Normalize => "normalize",
    DiagnosticStage::FindMatches => "find-matches",
    DiagnosticStage::FindRegex => "find.regex",
    DiagnosticStage::FindCustomRegex => "find.custom-regex",
    DiagnosticStage::FindLiteral => "find.literal",
    DiagnosticStage::SearchRegex => "search.regex",
    DiagnosticStage::SearchCustomRegex => "search.custom-regex",
    DiagnosticStage::SearchLegalForm => "search.legal-form",
    DiagnosticStage::SearchTrigger => "search.trigger",
    DiagnosticStage::SearchLiteral => "search.literal",
    DiagnosticStage::EntityRegex => "entity.regex",
    DiagnosticStage::EntityCustomRegex => "entity.custom-regex",
    DiagnosticStage::EntityAnchored => "entity.anchored",
    DiagnosticStage::EntityDenyList => "entity.deny-list",
    DiagnosticStage::EntityGazetteer => "entity.gazetteer",
    DiagnosticStage::EntityCountry => "entity.country",
    DiagnosticStage::EntityTrigger => "entity.trigger",
    DiagnosticStage::EntitySignature => "entity.signature",
    DiagnosticStage::EntityLegalForm => "entity.legal-form",
    DiagnosticStage::EntityAddressSeed => "entity.address-seed",
    DiagnosticStage::EntityNameCorpus => "entity.name-corpus",
    DiagnosticStage::EntityZoneAdjustment => "entity.zone-adjustment",
    DiagnosticStage::EntityAddressContext => "entity.address-context",
    DiagnosticStage::EntityCoreference => "entity.coreference",
    DiagnosticStage::Merge => "resolution.merge",
    DiagnosticStage::Boundary => "resolution.boundary",
    DiagnosticStage::Sanitize => "resolution.sanitize",
    DiagnosticStage::Redaction => "redaction",
  }
  .to_owned()
}

fn diagnostic_event_kind_name(kind: DiagnosticEventKind) -> String {
  match kind {
    DiagnosticEventKind::StageSummary => "stage-summary",
    DiagnosticEventKind::SearchMatch => "search-match",
    DiagnosticEventKind::Entity => "entity",
    DiagnosticEventKind::Rejection => "rejection",
  }
  .to_owned()
}

fn operator_name(operator: OperatorType) -> String {
  match operator {
    OperatorType::Replace => "replace",
    OperatorType::Redact => "redact",
  }
  .to_owned()
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::{
    BindingOperatorConfig, BindingPreparedSearchConfig, BindingSearchOptions,
    BindingSearchPattern, ContractError,
    MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
    PREPARED_SEARCH_PACKAGE_DIGEST_BYTES, operator_config_from_binding,
    prepared_search_config_from_binding,
    prepared_search_core_package_from_bytes,
    prepared_search_core_package_to_bytes,
    prepared_search_core_package_to_compressed_bytes,
    prepared_search_package_from_bytes,
    prepared_search_package_has_core_payload, prepared_search_package_to_bytes,
    prepared_search_package_to_compressed_bytes,
    static_redaction_diagnostics_to_utf16_binding, write_package_header,
  };
  use stella_anonymize_core::{
    DiagnosticEvent, DiagnosticEventKind, DiagnosticStage,
    StaticRedactionDiagnostics,
  };

  #[test]
  fn prepared_search_package_roundtrips_config_and_artifacts() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";

    let bytes = prepared_search_package_to_bytes(&config, artifacts).unwrap();
    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_package_rejects_invalid_bytes() {
    let error = prepared_search_package_from_bytes(b"not-valid").unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "invalid package bytes should fail before config construction"
    );
  }

  #[test]
  fn prepared_search_package_rejects_digest_mismatch() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_bytes(&config, b"artifact").unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "corrupted package payload should fail digest verification"
    );
  }

  #[test]
  fn binding_operator_config_accepts_camel_case_redact_string() {
    let config = serde_json::from_str::<BindingOperatorConfig>(
      r#"{"operators":{"country":"redact"},"redactString":"***"}"#,
    )
    .unwrap();
    let operators = operator_config_from_binding(Some(config)).unwrap();

    assert_eq!(operators.redact_string, "***");
  }

  #[test]
  fn binding_search_options_accept_regex_overlap_all() {
    let config = BindingPreparedSearchConfig {
      custom_regex_options: Some(BindingSearchOptions {
        regex_overlap_all: Some(true),
        ..BindingSearchOptions::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert!(core.custom_regex_options.regex.overlap_all);
  }

  #[test]
  fn utf16_diagnostics_reject_invalid_byte_offsets() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        count: None,
        engine: None,
        pattern: None,
        source: None,
        source_detail: None,
        label: None,
        start: Some(1),
        end: Some(2),
        text: None,
        score: None,
        span_valid: None,
        elapsed_us: None,
        input_bytes: None,
        reason: None,
      }],
    };

    let error = static_redaction_diagnostics_to_utf16_binding(diagnostics, "á")
      .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidBindingOffset { offset: 1 }
    ));
  }

  #[test]
  fn prepared_search_compressed_package_roundtrips_config_and_artifacts() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_package_to_compressed_bytes(&config, artifacts).unwrap();
    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_compressed_package_rejects_digest_mismatch() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "corrupted compressed package should fail digest verification"
    );
  }

  #[test]
  fn prepared_search_compressed_package_rejects_oversized_payload_len() {
    let bytes = compressed_package_with_len(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
      oversized_payload_len(),
    );
    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(
      error,
      "uncompressed payload length exceeds limit",
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_rejects_oversized_payload_len() {
    let bytes = compressed_package_with_len(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
      oversized_payload_len(),
    );
    let error = prepared_search_core_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(
      error,
      "uncompressed payload length exceeds limit",
    );
  }

  #[test]
  fn prepared_search_core_package_roundtrips_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_bytes(&config, artifacts).unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();
    let binding_error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
    assert!(
      matches!(
        binding_error,
        ContractError::InvalidPreparedSearchPackage { .. }
      ),
      "binding package loader should reject core payloads"
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_roundtrips_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, artifacts)
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
  }

  fn package_test_config() -> BindingPreparedSearchConfig {
    BindingPreparedSearchConfig {
      literal_patterns: vec![BindingSearchPattern {
        kind: String::from("literal"),
        pattern: String::from("Acme"),
        distance: None,
        case_insensitive: None,
        whole_words: None,
        lazy: None,
        prefilter_any: None,
        prefilter_case_insensitive: None,
        prefilter_regex: None,
      }],
      ..BindingPreparedSearchConfig::default()
    }
  }

  fn compressed_package_with_len(
    header: [u8; 8],
    version: u32,
    uncompressed_len: u64,
  ) -> Vec<u8> {
    let digest = [0; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES];
    let mut bytes = Vec::new();
    write_package_header(&mut bytes, header, version, &digest);
    bytes.extend_from_slice(&uncompressed_len.to_le_bytes());
    bytes
  }

  fn oversized_payload_len() -> u64 {
    u64::try_from(MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES)
      .unwrap()
      .checked_add(1)
      .unwrap()
  }

  fn assert_invalid_package_reason(error: ContractError, expected: &str) {
    assert!(
      matches!(
        error,
        ContractError::InvalidPreparedSearchPackage { reason }
          if reason == expected
      ),
      "expected invalid package reason: {expected}"
    );
  }
}
