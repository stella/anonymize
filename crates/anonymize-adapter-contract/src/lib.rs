use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use stella_anonymize_core::{
  AddressContextData, AddressSeedData, AmountWordsData, CoreferenceData,
  CoreferencePatternData, CountryMatchData, CurrencyData, DateData,
  DenyListFilterData, DenyListMatchData, DenyListPatternMetaSet,
  DetectionSource, DiagnosticEvent, DiagnosticEventKind, DiagnosticPhase,
  DiagnosticScope, DiagnosticStage, FuzzySearchOptions, GazetteerMatchData,
  HotwordRule, HotwordRuleData, LegalFormData, LiteralSearchOptions,
  MagnitudeSuffixData, MonetaryData, NameCorpusData, NameCorpusMode,
  OperatorConfig, OperatorType, PatternSlice, PipelineEntity,
  PreparedArtifactPolicy, PreparedEngineArtifacts, PreparedEngineConfig,
  PreparedEngineDetectorConfig, PreparedEnginePolicyConfig,
  PreparedEngineSearchConfig, PreparedEngineSlices, RedactionResult,
  RegexArtifactPolicy, RegexMatchMeta, RegexSearchOptions, SearchEngine,
  SearchOptions, SearchPattern, ShareQuantityTermData, SignatureData,
  SigningPlaceGuardData, SourceDetail, StaticRedactionDiagnosticResult,
  StaticRedactionDiagnostics, StaticRedactionResult,
  StaticRedactionStreamEvent, StringGroups, TriggerData, TriggerRule,
  TriggerStrategy, TriggerValidation, WrittenAmountPatternData, ZoneData,
  ZonePatternData, ZoneSigningClauseData,
};

mod assemble;
pub use assemble::{
  FIELDS_IMPLEMENTED, FIELDS_PENDING, assemble_static_search_config,
};

pub type Result<T> = std::result::Result<T, ContractError>;

const PREPARED_SEARCH_PACKAGE_HEADER: [u8; 8] = *b"ANONPKG1";
const PREPARED_SEARCH_PACKAGE_VERSION: u32 = 15;
const PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER: [u8; 8] = *b"ANONPKZ1";
const PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION: u32 = 14;
const PREPARED_SEARCH_COMPRESSED_PACKAGE_ZSTD_VERSION: u32 = 13;
const PREPARED_SEARCH_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION: u32 = 12;
const PREPARED_SEARCH_CORE_PACKAGE_HEADER: [u8; 8] = *b"ANONCPK1";
const PREPARED_SEARCH_CORE_PACKAGE_VERSION: u32 = 20;
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER: [u8; 8] = *b"ANONCPZ1";
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION: u32 = 22;
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_ZSTD_VERSION: u32 = 21;
const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION: u32 = 16;
const PREPARED_SEARCH_PACKAGE_DIGEST_BYTES: usize = 32;
#[cfg(test)]
const PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL: i32 = 1;
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
  pub prefilter_window_bytes: Option<u32>,
  pub prepared_artifact_policy: Option<BindingPreparedArtifactPolicy>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub regex_overlap_all: Option<bool>,
  pub regex_artifact_policy: Option<BindingRegexArtifactPolicy>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingRegexArtifactPolicy {
  Include,
  Omit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingPreparedArtifactPolicy {
  Include,
  Omit,
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
  #[serde(default)]
  pub phone_extension_labels: Vec<String>,
  #[serde(default)]
  pub number_markers: Vec<String>,
  #[serde(default)]
  pub number_labels: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingSignatureData {
  #[serde(default)]
  pub labels: Vec<String>,
  #[serde(default)]
  pub witness_phrases: Vec<String>,
  #[serde(default)]
  pub name_particles: Vec<String>,
  #[serde(default)]
  pub post_nominal_suffixes: Vec<String>,
  #[serde(default)]
  pub organization_suffixes: Vec<String>,
  #[serde(default)]
  pub image_stub_prefixes: Vec<String>,
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
  pub organization_suffixes: Vec<String>,
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
  pub signature_data: Option<BindingSignatureData>,
  #[serde(default)]
  pub name_corpus_mode: BindingNameCorpusMode,
  #[serde(default)]
  pub date_data: Option<BindingDateData>,
  #[serde(default)]
  pub monetary_data: Option<BindingMonetaryData>,
}

#[derive(
  Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum BindingNameCorpusMode {
  Full,
  #[default]
  Supplemental,
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
  pub config: PreparedEngineConfig,
  pub artifacts: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackageView<'a> {
  pub config: PreparedEngineConfig,
  pub artifacts: CorePreparedSearchPackageArtifacts<'a>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackageArtifacts<'a> {
  inner: CorePreparedSearchPackageArtifactsInner<'a>,
}

#[derive(Clone, Debug, PartialEq)]
enum CorePreparedSearchPackageArtifactsInner<'a> {
  Borrowed(&'a [u8]),
  OwnedPayload {
    payload: Vec<u8>,
    artifacts_start: usize,
  },
}

impl<'a> CorePreparedSearchPackageArtifacts<'a> {
  const fn borrowed(bytes: &'a [u8]) -> Self {
    Self {
      inner: CorePreparedSearchPackageArtifactsInner::Borrowed(bytes),
    }
  }

  fn owned_payload(payload: Vec<u8>, artifacts_start: usize) -> Result<Self> {
    if payload.get(artifacts_start..).is_none() {
      return Err(invalid_prepared_search_package("missing artifacts"));
    }
    Ok(Self {
      inner: CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        payload,
        artifacts_start,
      },
    })
  }

  #[must_use]
  pub fn as_bytes(&self) -> &[u8] {
    match &self.inner {
      CorePreparedSearchPackageArtifactsInner::Borrowed(bytes) => bytes,
      CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        payload,
        artifacts_start,
      } => payload.get(*artifacts_start..).unwrap_or_default(),
    }
  }

  #[must_use]
  pub fn into_owned(self) -> Vec<u8> {
    match self.inner {
      CorePreparedSearchPackageArtifactsInner::Borrowed(bytes) => {
        bytes.to_vec()
      }
      CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        payload,
        artifacts_start,
      } => payload
        .get(artifacts_start..)
        .map_or_else(Vec::new, <[u8]>::to_vec),
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedCorePreparedSearchPackage {
  pub config: PreparedEngineConfig,
  pub artifacts: PreparedEngineArtifacts,
  pub package_decode_timings: PreparedSearchPackageDecodeTimings,
  pub artifacts_decode: u64,
  pub artifacts_bytes: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchPackageDecodeTimings {
  pub verify: Option<u64>,
  pub decompress: Option<u64>,
  pub config_decode: Option<u64>,
  pub config_bytes: Option<usize>,
}

#[must_use]
pub const fn diagnostic_stage_event(
  stage: DiagnosticStage,
  count: Option<usize>,
  elapsed_us: Option<u64>,
  input_bytes: Option<usize>,
) -> DiagnosticEvent {
  DiagnosticEvent {
    stage,
    kind: DiagnosticEventKind::StageSummary,
    count,
    slot: None,
    subslot: None,
    pattern_count: None,
    engine: None,
    pattern: None,
    source: None,
    source_detail: None,
    label: None,
    start: None,
    end: None,
    text: None,
    score: None,
    span_valid: None,
    elapsed_us,
    input_bytes,
    artifact_count: None,
    artifact_bytes: None,
    reason: None,
  }
}

#[must_use]
pub fn prepared_search_package_decode_events(
  package_decode_elapsed: u64,
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  let mut events = vec![diagnostic_stage_event(
    DiagnosticStage::PreparePackageDecode,
    None,
    Some(package_decode_elapsed),
    Some(input_bytes_len),
  )];
  events.extend(prepared_search_package_decode_timing_events(
    timings,
    input_bytes_len,
  ));
  events
}

#[must_use]
pub fn prepared_search_package_decode_timing_events(
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  let mut events = Vec::new();
  if let Some(elapsed) = timings.verify {
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageVerify,
      None,
      Some(elapsed),
      Some(input_bytes_len),
    ));
  }
  if let Some(elapsed) = timings.decompress {
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageDecompress,
      None,
      Some(elapsed),
      Some(input_bytes_len),
    ));
  }
  if let Some(elapsed) = timings.config_decode {
    let input_bytes = timings.config_bytes.unwrap_or(input_bytes_len);
    events.push(diagnostic_stage_event(
      DiagnosticStage::PreparePackageConfigDecode,
      None,
      Some(elapsed),
      Some(input_bytes),
    ));
  }
  events
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
  signature_data: Option<BindingSignatureData>,
  name_corpus_mode: BindingNameCorpusMode,
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
  #[serde(default)]
  phone_extension_labels: Vec<String>,
  #[serde(default)]
  number_markers: Vec<String>,
  #[serde(default)]
  number_labels: Vec<String>,
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
  config: &PreparedEngineConfig,
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
  config: &PreparedEngineConfig,
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
  Ok(prepared_search_package_parts(bytes)?.digest())
}

pub fn prepared_search_package_verify_digest_with_timings(
  bytes: &[u8],
) -> Result<PreparedSearchPackageDecodeTimings> {
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  prepared_search_package_parts(bytes)?.verify_digest(&mut timings)?;
  Ok(timings)
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
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  let payload = parts.into_verified_payload(&mut timings)?;
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
  Ok(prepared_search_core_package_view_from_bytes_with_timings(bytes)?.0)
}

pub fn prepared_search_core_package_view_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  prepared_search_core_package_view_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Verify,
  )
}

pub fn prepared_search_core_package_view_trusted_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  prepared_search_core_package_view_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Trust,
  )
}

fn prepared_search_core_package_view_from_bytes_with_policy(
  bytes: &[u8],
  digest_policy: PackageDigestPolicy,
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  let parts = prepared_search_package_parts(bytes)?;
  if !parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a core payload",
    ));
  }
  let payload = parts.into_payload(&mut timings, digest_policy)?;
  let package = core_package_view_from_payload(payload, &mut timings)?;
  Ok((package, timings))
}

pub fn prepared_search_core_package_decode_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<DecodedCorePreparedSearchPackage> {
  prepared_search_core_package_decode_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Verify,
  )
}

pub fn prepared_search_core_package_decode_trusted_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<DecodedCorePreparedSearchPackage> {
  prepared_search_core_package_decode_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Trust,
  )
}

fn prepared_search_core_package_decode_from_bytes_with_policy(
  bytes: &[u8],
  digest_policy: PackageDigestPolicy,
) -> Result<DecodedCorePreparedSearchPackage> {
  let mut package_decode_timings =
    PreparedSearchPackageDecodeTimings::default();
  let parts = prepared_search_package_parts(bytes)?;
  if !parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a core payload",
    ));
  }
  let payload =
    parts.into_payload(&mut package_decode_timings, digest_policy)?;
  let slices = core_package_payload_slices(payload.as_ref())?;
  package_decode_timings.config_bytes = Some(slices.config.len());
  let (config, config_decode, artifacts, artifacts_decode) =
    decode_core_package_parts(slices.config, slices.artifacts)?;
  package_decode_timings.config_decode = Some(config_decode);
  Ok(DecodedCorePreparedSearchPackage {
    config,
    artifacts,
    package_decode_timings,
    artifacts_decode,
    artifacts_bytes: slices.artifacts.len(),
  })
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
      signature_data: config.signature_data,
      name_corpus_mode: config.name_corpus_mode,
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
      signature_data: config.signature_data,
      name_corpus_mode: config.name_corpus_mode,
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
      phone_extension_labels: data.phone_extension_labels,
      number_markers: data.number_markers,
      number_labels: data.number_labels,
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
      phone_extension_labels: data.phone_extension_labels,
      number_markers: data.number_markers,
      number_labels: data.number_labels,
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
  config: &PreparedEngineConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let mut config = config.clone();
  compact_core_package_config(&mut config);
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

fn compact_core_package_config(config: &mut PreparedEngineConfig) {
  if core_literal_patterns_are_identity_mapped(config) {
    config.search.literal_patterns.clear();
  }
  if let Some(data) = &mut config.detectors.deny_list_data {
    data.compact_runtime_patterns();
  }
}

fn core_package_view_from_payload<'a>(
  payload: Cow<'a, [u8]>,
  timings: &mut PreparedSearchPackageDecodeTimings,
) -> Result<CorePreparedSearchPackageView<'a>> {
  let (config, config_decode, artifacts_start) = {
    let payload_slices = core_package_payload_slices(payload.as_ref())?;
    timings.config_bytes = Some(payload_slices.config.len());
    let (config, config_decode) =
      decode_core_package_config(payload_slices.config)?;
    (config, config_decode, payload_slices.artifacts_start)
  };
  timings.config_decode = Some(config_decode);

  let artifacts = match payload {
    Cow::Borrowed(bytes) => CorePreparedSearchPackageArtifacts::borrowed(
      bytes
        .get(artifacts_start..)
        .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?,
    ),
    Cow::Owned(bytes) => {
      CorePreparedSearchPackageArtifacts::owned_payload(bytes, artifacts_start)?
    }
  };

  Ok(CorePreparedSearchPackageView { config, artifacts })
}

struct CorePackagePayloadSlices<'a> {
  config: &'a [u8],
  artifacts: &'a [u8],
  artifacts_start: usize,
}

fn core_package_payload_slices(
  payload: &[u8],
) -> Result<CorePackagePayloadSlices<'_>> {
  let len_end = std::mem::size_of::<u64>();
  let len_bytes = payload.get(..len_end).ok_or_else(|| {
    invalid_prepared_search_package("truncated config length")
  })?;
  let len_array = <[u8; 8]>::try_from(len_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed config length"))?;
  let config_len = usize::try_from(u64::from_le_bytes(len_array))
    .map_err(|_| invalid_prepared_search_package("config length overflow"))?;
  let config_end = len_end
    .checked_add(config_len)
    .ok_or_else(|| invalid_prepared_search_package("config length overflow"))?;
  let config = payload
    .get(len_end..config_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated config"))?;
  let artifacts = payload
    .get(config_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing artifacts"))?;
  Ok(CorePackagePayloadSlices {
    config,
    artifacts,
    artifacts_start: config_end,
  })
}

fn decode_core_package_parts(
  config_bytes: &[u8],
  artifacts_bytes: &[u8],
) -> Result<(PreparedEngineConfig, u64, PreparedEngineArtifacts, u64)> {
  stella_anonymize_core::exec::scope(|scope| {
    let config_handle =
      scope.spawn(|| decode_core_package_config(config_bytes));
    let artifacts_handle =
      scope.spawn(|| decode_core_package_artifacts(artifacts_bytes));
    let (config, config_decode) = join_core_package_decode(config_handle)?;
    let (artifacts, artifacts_decode) =
      join_core_package_decode(artifacts_handle)?;
    Ok((config, config_decode, artifacts, artifacts_decode))
  })
}

fn decode_core_package_config(
  config_bytes: &[u8],
) -> Result<(PreparedEngineConfig, u64)> {
  let config_decode_start = std::time::Instant::now();
  let (config, read) = bincode::serde::decode_from_slice::<
    PreparedEngineConfig,
    _,
  >(config_bytes, package_bincode_config())
  .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  let elapsed = elapsed_us(config_decode_start);
  if read != config_bytes.len() {
    return Err(invalid_prepared_search_package("trailing config data"));
  }
  Ok((config, elapsed))
}

fn decode_core_package_artifacts(
  artifacts_bytes: &[u8],
) -> Result<(PreparedEngineArtifacts, u64)> {
  let artifacts_decode_start = std::time::Instant::now();
  let artifacts = PreparedEngineArtifacts::from_bytes(artifacts_bytes)
    .map_err(|error| invalid_prepared_search_package(error.to_string()))?;
  Ok((artifacts, elapsed_us(artifacts_decode_start)))
}

fn join_core_package_decode<T>(
  handle: stella_anonymize_core::exec::JoinHandle<'_, Result<T>>,
) -> Result<T> {
  handle.join().map_err(|_| {
    invalid_prepared_search_package("core package decode panicked")
  })?
}

fn core_literal_patterns_are_identity_mapped(
  config: &PreparedEngineConfig,
) -> bool {
  !config.search.literal_patterns.is_empty()
    && config
      .search
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
  let compressed = lz4_flex::block::compress(payload);
  let digest = blake3::hash(&compressed);
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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BindingStaticRedactionStreamEvent {
  DetectedEntities {
    entities: Vec<BindingPipelineEntity>,
  },
  ResolvedEntities {
    entities: Vec<BindingPipelineEntity>,
  },
  Redacted {
    redaction: BindingRedactionResult,
  },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingDiagnosticEvent {
  pub phase: String,
  pub scope: String,
  pub stage: String,
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub slot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub subslot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pattern_count: Option<usize>,
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
  pub artifact_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub artifact_bytes: Option<usize>,
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
) -> Result<PreparedEngineConfig> {
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
  Ok(PreparedEngineConfig {
    search: PreparedEngineSearchConfig {
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
      slices: slices_from_binding(&config.slices),
      regex_meta: regex_meta_from_binding(config.regex_meta)?,
      custom_regex_meta: regex_meta_from_binding(config.custom_regex_meta)?,
    },
    policy: PreparedEnginePolicyConfig {
      allowed_labels: config.allowed_labels,
      threshold: config.threshold,
      confidence_boost: config.confidence_boost,
    },
    detectors: PreparedEngineDetectorConfig {
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
      name_corpus_data: config.name_corpus_data.map(|data| {
        name_corpus_data_from_binding(data, config.name_corpus_mode)
      }),
      signature_data: config.signature_data.map(signature_data_from_binding),
      date_data: config.date_data.map(|data| DateData {
        month_names_by_language: data.month_names_by_language,
        year_words_by_language: data.year_words_by_language,
      }),
      monetary_data: config.monetary_data.map(monetary_data_from_binding),
    },
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
    compression: PackageCompression,
    digest: [u8; 32],
    uncompressed_len: usize,
    payload: &'a [u8],
  },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PackageCompression {
  Lz4,
  ZstdCompressed,
  ZstdPayload,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PackageDigestPolicy {
  Verify,
  Trust,
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

  fn into_verified_payload(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
  ) -> Result<Cow<'a, [u8]>> {
    self.into_payload(timings, PackageDigestPolicy::Verify)
  }

  fn into_payload(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
    digest_policy: PackageDigestPolicy,
  ) -> Result<Cow<'a, [u8]>> {
    match self {
      Self::Raw {
        digest, payload, ..
      } => {
        if digest_policy == PackageDigestPolicy::Verify {
          let verify_start = std::time::Instant::now();
          verify_prepared_search_package_digest(digest, payload)?;
          timings.verify = Some(elapsed_us(verify_start));
        }
        Ok(Cow::Borrowed(payload))
      }
      Self::Compressed {
        compression,
        digest,
        uncompressed_len,
        payload,
        ..
      } => {
        if uncompressed_len > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "uncompressed payload length exceeds limit",
          ));
        }
        match compression {
          PackageCompression::Lz4 | PackageCompression::ZstdCompressed => {
            compressed_digest_payload(
              compression,
              digest,
              uncompressed_len,
              payload,
              timings,
              digest_policy,
            )
          }
          PackageCompression::ZstdPayload => {
            let decompress_start = std::time::Instant::now();
            let payload = decompress_package_payload(
              PackageCompression::ZstdPayload,
              payload,
              uncompressed_len,
            )?;
            timings.decompress = Some(elapsed_us(decompress_start));
            if digest_policy == PackageDigestPolicy::Verify {
              let verify_start = std::time::Instant::now();
              verify_prepared_search_package_digest(digest, &payload)?;
              timings.verify = Some(elapsed_us(verify_start));
            }
            Ok(Cow::Owned(payload))
          }
        }
      }
    }
  }

  fn verify_digest(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
  ) -> Result<()> {
    match self {
      Self::Raw {
        digest, payload, ..
      }
      | Self::Compressed {
        compression:
          PackageCompression::Lz4 | PackageCompression::ZstdCompressed,
        digest,
        payload,
        ..
      } => {
        let verify_start = std::time::Instant::now();
        verify_prepared_search_package_digest(digest, payload)?;
        timings.verify = Some(elapsed_us(verify_start));
        Ok(())
      }
      Self::Compressed {
        compression: PackageCompression::ZstdPayload,
        digest,
        uncompressed_len,
        payload,
        ..
      } => {
        if uncompressed_len > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "uncompressed payload length exceeds limit",
          ));
        }
        let decompress_start = std::time::Instant::now();
        let payload = decompress_zstd_payload(payload, uncompressed_len)?;
        timings.decompress = Some(elapsed_us(decompress_start));
        let verify_start = std::time::Instant::now();
        verify_prepared_search_package_digest(digest, &payload)?;
        timings.verify = Some(elapsed_us(verify_start));
        Ok(())
      }
    }
  }
}

fn compressed_digest_payload<'a>(
  compression: PackageCompression,
  digest: [u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
  uncompressed_len: usize,
  payload: &'a [u8],
  timings: &mut PreparedSearchPackageDecodeTimings,
  digest_policy: PackageDigestPolicy,
) -> Result<Cow<'a, [u8]>> {
  if digest_policy == PackageDigestPolicy::Trust {
    let decompress_start = std::time::Instant::now();
    let decompressed =
      decompress_package_payload(compression, payload, uncompressed_len)?;
    timings.decompress = Some(elapsed_us(decompress_start));
    return Ok(Cow::Owned(decompressed));
  }

  let (verify_result, verify_elapsed, decompressed, decompress_elapsed) =
    stella_anonymize_core::exec::scope(|scope| {
      let verify_handle = scope.spawn(|| {
        let verify_start = std::time::Instant::now();
        let result = verify_prepared_search_package_digest(digest, payload);
        (result, elapsed_us(verify_start))
      });
      let decompress_handle = scope.spawn(|| {
        let decompress_start = std::time::Instant::now();
        let result =
          decompress_package_payload(compression, payload, uncompressed_len);
        (result, elapsed_us(decompress_start))
      });
      let (verify_result, verify_elapsed) =
        join_package_decode_thread(verify_handle)?;
      let (decompressed, decompress_elapsed) =
        join_package_decode_thread(decompress_handle)?;
      Ok((
        verify_result,
        verify_elapsed,
        decompressed,
        decompress_elapsed,
      ))
    })?;
  verify_result?;
  timings.verify = Some(verify_elapsed);
  let decompressed = decompressed.map(Cow::Owned)?;
  timings.decompress = Some(decompress_elapsed);
  Ok(decompressed)
}

fn decompress_package_payload(
  compression: PackageCompression,
  payload: &[u8],
  uncompressed_len: usize,
) -> Result<Vec<u8>> {
  match compression {
    PackageCompression::Lz4 => {
      lz4_flex::block::decompress(payload, uncompressed_len)
        .map_err(|error| invalid_prepared_search_package(error.to_string()))
    }
    PackageCompression::ZstdCompressed | PackageCompression::ZstdPayload => {
      decompress_zstd_payload(payload, uncompressed_len)
    }
  }
}

/// zstd decode path. The write path always emits lz4, so zstd support is only
/// needed to read externally produced zstd-tagged packages. It is gated behind
/// the default `zstd` feature so wasm targets (where the zstd C library does not
/// cross-compile) can drop it and still load the lz4 packages this crate emits.
#[cfg(feature = "zstd")]
fn decompress_zstd_payload(
  payload: &[u8],
  uncompressed_len: usize,
) -> Result<Vec<u8>> {
  zstd::bulk::decompress(payload, uncompressed_len)
    .map_err(|error| invalid_prepared_search_package(error.to_string()))
}

#[cfg(not(feature = "zstd"))]
fn decompress_zstd_payload(
  _payload: &[u8],
  _uncompressed_len: usize,
) -> Result<Vec<u8>> {
  Err(invalid_prepared_search_package(
    "zstd-compressed prepared packages are not supported in this build",
  ))
}

fn join_package_decode_thread<T>(
  handle: stella_anonymize_core::exec::JoinHandle<'_, T>,
) -> Result<T> {
  handle.join().map_err(|_| {
    invalid_prepared_search_package("package decode thread panicked")
  })
}

#[derive(Clone, Copy)]
struct RawPackageHeader<'a> {
  version: u32,
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
    let (raw, compression) = compressed_package_header(
      bytes,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_ZSTD_VERSION,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    return compressed_package_parts(false, raw, compression);
  }
  if header == PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER {
    let (raw, compression) = compressed_package_header(
      bytes,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_ZSTD_VERSION,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    return compressed_package_parts(true, raw, compression);
  }
  Err(invalid_prepared_search_package("unexpected header"))
}

fn compressed_package_parts(
  core: bool,
  raw: RawPackageHeader<'_>,
  compression: PackageCompression,
) -> Result<PreparedSearchPackageParts<'_>> {
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
  Ok(PreparedSearchPackageParts::Compressed {
    core,
    compression,
    digest: raw.digest,
    uncompressed_len,
    payload,
  })
}

fn compressed_package_header(
  bytes: &[u8],
  lz4_compressed_digest_version: u32,
  zstd_compressed_digest_version: u32,
  payload_digest_version: u32,
  header_len: usize,
) -> Result<(RawPackageHeader<'_>, PackageCompression)> {
  let raw = raw_package_header_any_version(bytes, header_len)?;
  let compression = if raw.version == lz4_compressed_digest_version {
    PackageCompression::Lz4
  } else if raw.version == zstd_compressed_digest_version {
    PackageCompression::ZstdCompressed
  } else if raw.version == payload_digest_version {
    PackageCompression::ZstdPayload
  } else {
    return Err(invalid_prepared_search_package("unsupported version"));
  };
  Ok((raw, compression))
}

fn raw_package_header(
  bytes: &[u8],
  expected_version: u32,
  header_len: usize,
) -> Result<RawPackageHeader<'_>> {
  let raw = raw_package_header_any_version(bytes, header_len)?;
  if raw.version != expected_version {
    return Err(invalid_prepared_search_package("unsupported version"));
  }
  Ok(raw)
}

fn raw_package_header_any_version(
  bytes: &[u8],
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
  Ok(RawPackageHeader {
    version,
    digest,
    payload,
  })
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

fn elapsed_us(start: std::time::Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
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
    pattern_meta: DenyListPatternMetaSet::default(),
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
    organization_suffixes: data.organization_suffixes,
    organization_determiners: data.organization_determiners,
  }
}

fn name_corpus_data_from_binding(
  data: BindingNameCorpusData,
  mode: BindingNameCorpusMode,
) -> NameCorpusData {
  NameCorpusData {
    mode: name_corpus_mode_from_binding(mode),
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

fn signature_data_from_binding(data: BindingSignatureData) -> SignatureData {
  SignatureData {
    labels: data.labels,
    witness_phrases: data.witness_phrases,
    name_particles: data.name_particles,
    post_nominal_suffixes: data.post_nominal_suffixes,
    organization_suffixes: data.organization_suffixes,
    image_stub_prefixes: data.image_stub_prefixes,
  }
}

const fn name_corpus_mode_from_binding(
  mode: BindingNameCorpusMode,
) -> NameCorpusMode {
  match mode {
    BindingNameCorpusMode::Full => NameCorpusMode::Full,
    BindingNameCorpusMode::Supplemental => NameCorpusMode::Supplemental,
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
      .map(binding_pipeline_entity_from_core)
      .collect(),
    redaction: binding_redaction_result_from_core(result.redaction),
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
pub fn static_redaction_stream_event_to_binding(
  event: StaticRedactionStreamEvent<'_>,
) -> BindingStaticRedactionStreamEvent {
  match event {
    StaticRedactionStreamEvent::DetectedEntities(detections) => {
      BindingStaticRedactionStreamEvent::DetectedEntities {
        entities: detections
          .all_entities()
          .into_iter()
          .map(binding_pipeline_entity_from_core)
          .collect(),
      }
    }
    StaticRedactionStreamEvent::ResolvedEntities(entities) => {
      BindingStaticRedactionStreamEvent::ResolvedEntities {
        entities: entities
          .iter()
          .map(binding_pipeline_entity_from_core_ref)
          .collect(),
      }
    }
    StaticRedactionStreamEvent::Redacted(redaction) => {
      BindingStaticRedactionStreamEvent::Redacted {
        redaction: binding_redaction_result_from_core_ref(redaction),
      }
    }
  }
}

pub fn static_redaction_stream_event_to_utf16_binding(
  event: StaticRedactionStreamEvent<'_>,
  full_text: &str,
) -> Result<BindingStaticRedactionStreamEvent> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut event = static_redaction_stream_event_to_binding(event);
  match &mut event {
    BindingStaticRedactionStreamEvent::DetectedEntities { entities }
    | BindingStaticRedactionStreamEvent::ResolvedEntities { entities } => {
      convert_pipeline_entity_offsets(entities, &offsets)?;
    }
    BindingStaticRedactionStreamEvent::Redacted { .. } => {}
  }
  Ok(event)
}

fn binding_pipeline_entity_from_core(
  entity: PipelineEntity,
) -> BindingPipelineEntity {
  BindingPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: detection_source_name(entity.source),
    source_detail: entity.source_detail.map(source_detail_name),
  }
}

fn binding_pipeline_entity_from_core_ref(
  entity: &PipelineEntity,
) -> BindingPipelineEntity {
  BindingPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label.clone(),
    text: entity.text.clone(),
    score: entity.score,
    source: detection_source_name(entity.source),
    source_detail: entity.source_detail.map(source_detail_name),
  }
}

fn binding_redaction_result_from_core(
  redaction: RedactionResult,
) -> BindingRedactionResult {
  BindingRedactionResult {
    redacted_text: redaction.redacted_text,
    redaction_map: redaction
      .redaction_map
      .into_iter()
      .map(|entry| BindingRedactionEntry {
        placeholder: entry.placeholder,
        original: entry.original,
      })
      .collect(),
    operator_map: redaction
      .operator_map
      .into_iter()
      .map(|entry| BindingOperatorEntry {
        placeholder: entry.placeholder,
        operator: operator_name(entry.operator),
      })
      .collect(),
    entity_count: redaction.entity_count,
  }
}

fn binding_redaction_result_from_core_ref(
  redaction: &RedactionResult,
) -> BindingRedactionResult {
  BindingRedactionResult {
    redacted_text: redaction.redacted_text.clone(),
    redaction_map: redaction
      .redaction_map
      .iter()
      .map(|entry| BindingRedactionEntry {
        placeholder: entry.placeholder.clone(),
        original: entry.original.clone(),
      })
      .collect(),
    operator_map: redaction
      .operator_map
      .iter()
      .map(|entry| BindingOperatorEntry {
        placeholder: entry.placeholder.clone(),
        operator: operator_name(entry.operator),
      })
      .collect(),
    entity_count: redaction.entity_count,
  }
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

#[must_use]
pub fn diagnostic_events_to_binding(
  events: &[DiagnosticEvent],
) -> BindingStaticRedactionDiagnostics {
  BindingStaticRedactionDiagnostics {
    events: events
      .iter()
      .cloned()
      .map(diagnostic_event_to_binding)
      .collect(),
  }
}

pub fn diagnostic_events_to_utf16_binding(
  events: &[DiagnosticEvent],
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnostics> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut diagnostics = diagnostic_events_to_binding(events);
  convert_diagnostic_offsets(&mut diagnostics.events, &offsets)?;
  Ok(diagnostics)
}

fn diagnostic_event_to_binding(
  event: DiagnosticEvent,
) -> BindingDiagnosticEvent {
  BindingDiagnosticEvent {
    phase: diagnostic_phase_name(event.stage.phase()),
    scope: diagnostic_scope_name(event.scope()),
    stage: diagnostic_stage_name(event.stage),
    kind: diagnostic_event_kind_name(event.kind),
    count: event.count,
    slot: event.slot,
    subslot: event.subslot,
    pattern_count: event.pattern_count,
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
    artifact_count: event.artifact_count,
    artifact_bytes: event.artifact_bytes,
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

enum Utf16OffsetMap {
  Identity { byte_len: u32 },
  Boundaries(Vec<(u32, u32)>),
}

impl Utf16OffsetMap {
  fn new(text: &str) -> Result<Self> {
    if text.is_ascii() {
      return Ok(Self::Identity {
        byte_len: u32_from_usize(text.len())?,
      });
    }

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

    Ok(Self::Boundaries(boundaries))
  }

  fn convert(&self, offset: u32) -> Result<u32> {
    self
      .try_convert(offset)
      .ok_or(ContractError::InvalidBindingOffset { offset })
  }

  fn try_convert(&self, offset: u32) -> Option<u32> {
    match self {
      Self::Identity { byte_len } => (offset <= *byte_len).then_some(offset),
      Self::Boundaries(boundaries) => {
        let index = boundaries
          .binary_search_by_key(&offset, |(byte_offset, _)| *byte_offset)
          .ok()?;
        boundaries.get(index).map(|(_, utf16_offset)| *utf16_offset)
      }
    }
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
    phone_extension_labels: data.phone_extension_labels,
    number_markers: data.number_markers,
    number_labels: data.number_labels,
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
        || pattern.prefilter_window_bytes.is_some()
        || pattern.prepared_artifact_policy.is_some()
      {
        return Ok(SearchPattern::RegexWithOptions {
          pattern: pattern.pattern,
          lazy: pattern.lazy.unwrap_or(false),
          prefilter_any: pattern.prefilter_any.unwrap_or_default(),
          prefilter_case_insensitive: pattern.prefilter_case_insensitive,
          prefilter_regex: pattern.prefilter_regex,
          prefilter_window_bytes: pattern
            .prefilter_window_bytes
            .and_then(|value| usize::try_from(value).ok()),
          prepared_artifact_policy: pattern
            .prepared_artifact_policy
            .map(prepared_artifact_policy_from_binding),
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

const fn prepared_artifact_policy_from_binding(
  policy: BindingPreparedArtifactPolicy,
) -> PreparedArtifactPolicy {
  match policy {
    BindingPreparedArtifactPolicy::Include => PreparedArtifactPolicy::Include,
    BindingPreparedArtifactPolicy::Omit => PreparedArtifactPolicy::Omit,
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
      artifact_policy: match options.regex_artifact_policy {
        Some(BindingRegexArtifactPolicy::Include) | None => {
          RegexArtifactPolicy::Include
        }
        Some(BindingRegexArtifactPolicy::Omit) => RegexArtifactPolicy::Omit,
      },
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
) -> PreparedEngineSlices {
  PreparedEngineSlices {
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

fn diagnostic_phase_name(phase: DiagnosticPhase) -> String {
  match phase {
    DiagnosticPhase::Prepare => "prepare",
    DiagnosticPhase::Warm => "warm",
    DiagnosticPhase::Search => "search",
    DiagnosticPhase::Detect => "detect",
    DiagnosticPhase::Resolve => "resolve",
    DiagnosticPhase::Redact => "redact",
  }
  .to_owned()
}

fn diagnostic_scope_name(scope: DiagnosticScope) -> String {
  match scope {
    DiagnosticScope::Total => "total",
    DiagnosticScope::Step => "step",
    DiagnosticScope::Slot => "slot",
    DiagnosticScope::Detail => "detail",
  }
  .to_owned()
}

fn diagnostic_stage_name(stage: DiagnosticStage) -> String {
  match stage {
    DiagnosticStage::PrepareCacheKey
    | DiagnosticStage::PrepareCacheBypass
    | DiagnosticStage::PrepareCacheHit
    | DiagnosticStage::PrepareCacheMiss
    | DiagnosticStage::PrepareBindingParse
    | DiagnosticStage::PreparePackageDecode
    | DiagnosticStage::PreparePackageVerify
    | DiagnosticStage::PreparePackageDecompress
    | DiagnosticStage::PreparePackageConfigDecode
    | DiagnosticStage::PrepareBindingConvert
    | DiagnosticStage::PrepareArtifactsDecode
    | DiagnosticStage::PrepareTotal
    | DiagnosticStage::PrepareRegex
    | DiagnosticStage::PrepareCustomRegex
    | DiagnosticStage::PrepareAnchored
    | DiagnosticStage::PrepareLegalFormSearch
    | DiagnosticStage::PrepareTriggerSearch
    | DiagnosticStage::PrepareLiteral
    | DiagnosticStage::PrepareHotwordData
    | DiagnosticStage::PrepareTriggerData
    | DiagnosticStage::PrepareLegalFormData
    | DiagnosticStage::PrepareAddressSeedData
    | DiagnosticStage::PrepareZoneData
    | DiagnosticStage::PrepareAddressContextData
    | DiagnosticStage::PrepareCoreferenceData
    | DiagnosticStage::PrepareNameCorpusData
    | DiagnosticStage::PrepareSignatureData => {
      diagnostic_prepare_stage_name(stage)
    }
    DiagnosticStage::WarmRegex
    | DiagnosticStage::WarmCustomRegex
    | DiagnosticStage::WarmLegalFormSearch
    | DiagnosticStage::WarmTriggerSearch
    | DiagnosticStage::WarmLiteral
    | DiagnosticStage::WarmTotal => diagnostic_warm_stage_name(stage),
    DiagnosticStage::Normalize
    | DiagnosticStage::FindMatches
    | DiagnosticStage::FindRegex
    | DiagnosticStage::FindCustomRegex
    | DiagnosticStage::FindLegalForm
    | DiagnosticStage::FindTrigger
    | DiagnosticStage::FindLiteral
    | DiagnosticStage::SearchRegex
    | DiagnosticStage::SearchCustomRegex
    | DiagnosticStage::SearchLegalForm
    | DiagnosticStage::SearchTrigger
    | DiagnosticStage::SearchLiteral => diagnostic_search_stage_name(stage),
    DiagnosticStage::DetectTotal
    | DiagnosticStage::EntityRegex
    | DiagnosticStage::EntityCustomRegex
    | DiagnosticStage::EntityAnchored
    | DiagnosticStage::EntityDenyList
    | DiagnosticStage::EntityGazetteer
    | DiagnosticStage::EntityCountry
    | DiagnosticStage::EntityTrigger
    | DiagnosticStage::EntitySignature
    | DiagnosticStage::EntityLegalForm
    | DiagnosticStage::EntityAddressSeed
    | DiagnosticStage::EntityAddressSeedContext
    | DiagnosticStage::EntityAddressSeedCollect
    | DiagnosticStage::EntityAddressSeedCollectStreetTypes
    | DiagnosticStage::EntityAddressSeedCollectExisting
    | DiagnosticStage::EntityAddressSeedCollectStreetNumbers
    | DiagnosticStage::EntityAddressSeedCollectPostalCodes
    | DiagnosticStage::EntityAddressSeedCollectItalianCap
    | DiagnosticStage::EntityAddressSeedCluster
    | DiagnosticStage::EntityAddressSeedBoundary
    | DiagnosticStage::EntityAddressSeedExpand
    | DiagnosticStage::EntityNameCorpus
    | DiagnosticStage::EntityNameCorpusCjk
    | DiagnosticStage::EntityNameCorpusSegment
    | DiagnosticStage::EntityNameCorpusSeed
    | DiagnosticStage::EntityNameCorpusClassify
    | DiagnosticStage::EntityNameCorpusChains
    | DiagnosticStage::EntityNameCorpusDedupe
    | DiagnosticStage::EntityNameCorpusFilter => {
      diagnostic_detect_stage_name(stage)
    }
    DiagnosticStage::EntityZoneAdjustment
    | DiagnosticStage::EntityHotword
    | DiagnosticStage::EntityAddressContext
    | DiagnosticStage::EntityCoreference
    | DiagnosticStage::Merge
    | DiagnosticStage::Boundary
    | DiagnosticStage::Sanitize
    | DiagnosticStage::RedactTotal
    | DiagnosticStage::Redaction => diagnostic_finish_stage_name(stage),
  }
  .to_owned()
}

const fn diagnostic_prepare_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::PrepareCacheKey => "prepare.cache-key",
    DiagnosticStage::PrepareCacheBypass => "prepare.cache.bypass",
    DiagnosticStage::PrepareCacheHit => "prepare.cache.hit",
    DiagnosticStage::PrepareCacheMiss => "prepare.cache.miss",
    DiagnosticStage::PrepareBindingParse => "prepare.binding.parse",
    DiagnosticStage::PreparePackageDecode => "prepare.package.decode",
    DiagnosticStage::PreparePackageVerify => "prepare.package.verify",
    DiagnosticStage::PreparePackageDecompress => "prepare.package.decompress",
    DiagnosticStage::PreparePackageConfigDecode => {
      "prepare.package.config-decode"
    }
    DiagnosticStage::PrepareBindingConvert => "prepare.binding.convert",
    DiagnosticStage::PrepareArtifactsDecode => "prepare.artifacts.decode",
    DiagnosticStage::PrepareTotal => "prepare.total",
    DiagnosticStage::PrepareRegex => "prepare.regex",
    DiagnosticStage::PrepareCustomRegex => "prepare.custom-regex",
    DiagnosticStage::PrepareAnchored => "prepare.anchored",
    DiagnosticStage::PrepareLegalFormSearch => "prepare.legal-form-search",
    DiagnosticStage::PrepareTriggerSearch => "prepare.trigger-search",
    DiagnosticStage::PrepareLiteral => "prepare.literal",
    DiagnosticStage::PrepareHotwordData => "prepare.hotword-data",
    DiagnosticStage::PrepareTriggerData => "prepare.trigger-data",
    DiagnosticStage::PrepareLegalFormData => "prepare.legal-form-data",
    DiagnosticStage::PrepareAddressSeedData => "prepare.address-seed-data",
    DiagnosticStage::PrepareZoneData => "prepare.zone-data",
    DiagnosticStage::PrepareAddressContextData => {
      "prepare.address-context-data"
    }
    DiagnosticStage::PrepareCoreferenceData => "prepare.coreference-data",
    DiagnosticStage::PrepareNameCorpusData => "prepare.name-corpus-data",
    DiagnosticStage::PrepareSignatureData => "prepare.signature-data",
    _ => "prepare.unknown",
  }
}

const fn diagnostic_warm_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::WarmRegex => "warm.regex",
    DiagnosticStage::WarmCustomRegex => "warm.custom-regex",
    DiagnosticStage::WarmLegalFormSearch => "warm.legal-form-search",
    DiagnosticStage::WarmTriggerSearch => "warm.trigger-search",
    DiagnosticStage::WarmLiteral => "warm.literal",
    DiagnosticStage::WarmTotal => "warm.total",
    _ => "warm.unknown",
  }
}

const fn diagnostic_search_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::Normalize => "normalize",
    DiagnosticStage::FindMatches => "find-matches",
    DiagnosticStage::FindRegex => "find.regex",
    DiagnosticStage::FindCustomRegex => "find.custom-regex",
    DiagnosticStage::FindLegalForm => "find.legal-form",
    DiagnosticStage::FindTrigger => "find.trigger",
    DiagnosticStage::FindLiteral => "find.literal",
    DiagnosticStage::SearchRegex => "search.regex",
    DiagnosticStage::SearchCustomRegex => "search.custom-regex",
    DiagnosticStage::SearchLegalForm => "search.legal-form",
    DiagnosticStage::SearchTrigger => "search.trigger",
    DiagnosticStage::SearchLiteral => "search.literal",
    _ => "search.unknown",
  }
}

const fn diagnostic_detect_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::DetectTotal => "detect.total",
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
    DiagnosticStage::EntityAddressSeedContext => "entity.address-seed.context",
    DiagnosticStage::EntityAddressSeedCollect => "entity.address-seed.collect",
    DiagnosticStage::EntityAddressSeedCollectStreetTypes => {
      "entity.address-seed.collect.street-types"
    }
    DiagnosticStage::EntityAddressSeedCollectExisting => {
      "entity.address-seed.collect.existing"
    }
    DiagnosticStage::EntityAddressSeedCollectStreetNumbers => {
      "entity.address-seed.collect.street-numbers"
    }
    DiagnosticStage::EntityAddressSeedCollectPostalCodes => {
      "entity.address-seed.collect.postal-codes"
    }
    DiagnosticStage::EntityAddressSeedCollectItalianCap => {
      "entity.address-seed.collect.italian-cap"
    }
    DiagnosticStage::EntityAddressSeedCluster => "entity.address-seed.cluster",
    DiagnosticStage::EntityAddressSeedBoundary => {
      "entity.address-seed.boundary"
    }
    DiagnosticStage::EntityAddressSeedExpand => "entity.address-seed.expand",
    DiagnosticStage::EntityNameCorpus => "entity.name-corpus",
    DiagnosticStage::EntityNameCorpusCjk => "entity.name-corpus.cjk",
    DiagnosticStage::EntityNameCorpusSegment => "entity.name-corpus.segment",
    DiagnosticStage::EntityNameCorpusSeed => "entity.name-corpus.seed",
    DiagnosticStage::EntityNameCorpusClassify => "entity.name-corpus.classify",
    DiagnosticStage::EntityNameCorpusChains => "entity.name-corpus.chains",
    DiagnosticStage::EntityNameCorpusDedupe => "entity.name-corpus.dedupe",
    DiagnosticStage::EntityNameCorpusFilter => "entity.name-corpus.filter",
    _ => "detect.unknown",
  }
}

const fn diagnostic_finish_stage_name(stage: DiagnosticStage) -> &'static str {
  match stage {
    DiagnosticStage::EntityZoneAdjustment => "entity.zone-adjustment",
    DiagnosticStage::EntityHotword => "entity.hotword",
    DiagnosticStage::EntityAddressContext => "entity.address-context",
    DiagnosticStage::EntityCoreference => "entity.coreference",
    DiagnosticStage::Merge => "resolution.merge",
    DiagnosticStage::Boundary => "resolution.boundary",
    DiagnosticStage::Sanitize => "resolution.sanitize",
    DiagnosticStage::RedactTotal => "redact.total",
    DiagnosticStage::Redaction => "redaction",
    _ => "finish.unknown",
  }
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
    BindingDenyListMatchData, BindingOperatorConfig,
    BindingPreparedArtifactPolicy, BindingPreparedSearchConfig,
    BindingRegexArtifactPolicy, BindingSearchOptions, BindingSearchPattern,
    ContractError, CorePreparedSearchPackageArtifactsInner,
    MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_ZSTD_VERSION,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_ZSTD_VERSION,
    PREPARED_SEARCH_PACKAGE_DIGEST_BYTES, PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL,
    PreparedSearchPackageDecodeTimings, diagnostic_events_to_binding,
    diagnostic_events_to_utf16_binding, diagnostic_stage_event,
    operator_config_from_binding, prepared_search_config_from_binding,
    prepared_search_core_package_decode_from_bytes_with_timings,
    prepared_search_core_package_decode_trusted_from_bytes_with_timings,
    prepared_search_core_package_from_bytes,
    prepared_search_core_package_payload_to_bytes,
    prepared_search_core_package_to_bytes,
    prepared_search_core_package_to_compressed_bytes,
    prepared_search_core_package_view_from_bytes_with_timings,
    prepared_search_core_package_view_trusted_from_bytes_with_timings,
    prepared_search_package_decode_events,
    prepared_search_package_decode_timing_events,
    prepared_search_package_digest, prepared_search_package_from_bytes,
    prepared_search_package_has_core_payload,
    prepared_search_package_payload_to_bytes, prepared_search_package_to_bytes,
    prepared_search_package_to_compressed_bytes,
    prepared_search_package_verify_digest_with_timings,
    static_redaction_diagnostics_to_utf16_binding, write_package_header,
  };
  use stella_anonymize_core::{
    DiagnosticEvent, DiagnosticEventKind, DiagnosticStage,
    PreparedArtifactPolicy, PreparedEngineArtifacts, RegexArtifactPolicy,
    SearchPattern, StaticRedactionDiagnostics,
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
  fn prepared_search_package_digest_reads_header_without_verifying_payload() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_bytes(&config, b"artifact").unwrap();
    let digest = prepared_search_package_digest(&bytes).unwrap();

    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    assert_eq!(prepared_search_package_digest(&bytes).unwrap(), digest);
    assert!(
      prepared_search_package_verify_digest_with_timings(&bytes).is_err(),
      "header digest identity must not replace payload verification"
    );
  }

  #[test]
  fn prepared_search_package_verify_digest_reports_timing() {
    let config = BindingPreparedSearchConfig::default();
    let bytes =
      prepared_search_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();

    let timings =
      prepared_search_package_verify_digest_with_timings(&bytes).unwrap();

    assert!(
      timings.verify.is_some(),
      "digest verification timing should be reported"
    );
  }

  #[test]
  fn prepared_search_package_decode_events_report_ordered_stages() {
    let events = prepared_search_package_decode_events(
      10,
      PreparedSearchPackageDecodeTimings {
        verify: Some(2),
        decompress: None,
        config_decode: Some(3),
        config_bytes: Some(64),
      },
      128,
    );

    let stages = events.iter().map(|event| event.stage).collect::<Vec<_>>();

    assert_eq!(
      stages,
      vec![
        DiagnosticStage::PreparePackageDecode,
        DiagnosticStage::PreparePackageVerify,
        DiagnosticStage::PreparePackageConfigDecode,
      ]
    );
    assert_eq!(
      events.first().unwrap(),
      &diagnostic_stage_event(
        DiagnosticStage::PreparePackageDecode,
        None,
        Some(10),
        Some(128),
      )
    );
    assert_eq!(
      events.last().unwrap().input_bytes,
      Some(64),
      "config decode should report encoded config bytes"
    );
  }

  #[test]
  fn prepared_search_package_decode_timing_events_skip_missing_timings() {
    let events = prepared_search_package_decode_timing_events(
      PreparedSearchPackageDecodeTimings::default(),
      128,
    );

    assert!(events.is_empty());
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

    assert!(core.search.custom_regex_options.regex.overlap_all);
  }

  #[test]
  fn binding_search_options_accept_regex_artifact_policy() {
    let config = BindingPreparedSearchConfig {
      regex_options: Some(BindingSearchOptions {
        regex_artifact_policy: Some(BindingRegexArtifactPolicy::Omit),
        ..BindingSearchOptions::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert_eq!(
      core.search.regex_options.regex.artifact_policy,
      RegexArtifactPolicy::Omit
    );
  }

  #[test]
  fn binding_regex_patterns_accept_prepared_artifact_policy() {
    let config = BindingPreparedSearchConfig {
      regex_patterns: vec![BindingSearchPattern {
        kind: "regex".to_string(),
        pattern: "SSN\\s+\\d+".to_string(),
        distance: None,
        case_insensitive: None,
        whole_words: None,
        lazy: Some(true),
        prefilter_any: Some(vec!["SSN".to_string()]),
        prefilter_case_insensitive: Some(false),
        prefilter_regex: None,
        prefilter_window_bytes: Some(80),
        prepared_artifact_policy: Some(BindingPreparedArtifactPolicy::Omit),
      }],
      ..BindingPreparedSearchConfig::default()
    };
    let core = prepared_search_config_from_binding(config).unwrap();

    assert!(matches!(
      core.search.regex_patterns.first(),
      Some(SearchPattern::RegexWithOptions {
        prepared_artifact_policy: Some(PreparedArtifactPolicy::Omit),
        ..
      })
    ));
  }

  #[test]
  fn utf16_diagnostics_reject_invalid_byte_offsets() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
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
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let error = static_redaction_diagnostics_to_utf16_binding(diagnostics, "á")
      .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidBindingOffset { offset: 1 }
    ));
  }

  #[test]
  fn ascii_diagnostics_reject_out_of_range_offsets() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        start: Some(4),
        end: Some(5),
        ..diagnostic_stage_event(DiagnosticStage::EntityRegex, None, None, None)
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let error =
      static_redaction_diagnostics_to_utf16_binding(diagnostics, "abc")
        .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidBindingOffset { offset: 4 }
    ));
  }

  #[test]
  fn binding_diagnostic_events_include_pipeline_phase() {
    let mut prepare_regex =
      diagnostic_stage_event(DiagnosticStage::PrepareRegex, None, None, None);
    prepare_regex.slot = Some(0);

    let events = vec![
      prepare_regex,
      diagnostic_stage_event(DiagnosticStage::FindLiteral, None, None, None),
      diagnostic_stage_event(DiagnosticStage::EntityDenyList, None, None, None),
      diagnostic_stage_event(DiagnosticStage::EntityHotword, None, None, None),
      diagnostic_stage_event(DiagnosticStage::RedactTotal, None, None, None),
    ];

    let diagnostics = diagnostic_events_to_binding(&events);
    let metadata = diagnostics
      .events
      .iter()
      .map(|event| {
        (
          event.stage.as_str(),
          event.phase.as_str(),
          event.scope.as_str(),
        )
      })
      .collect::<Vec<_>>();

    assert_eq!(
      metadata,
      vec![
        ("prepare.regex", "prepare", "slot"),
        ("find.literal", "search", "step"),
        ("entity.deny-list", "detect", "step"),
        ("entity.hotword", "resolve", "step"),
        ("redact.total", "redact", "total"),
      ]
    );
  }

  #[test]
  fn utf16_diagnostic_event_batches_match_full_diagnostics() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
        engine: None,
        pattern: None,
        source: None,
        source_detail: None,
        label: Some("name".to_string()),
        start: Some(0),
        end: Some(2),
        text: None,
        score: Some(0.9),
        span_valid: Some(true),
        elapsed_us: Some(12),
        input_bytes: None,
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let full =
      static_redaction_diagnostics_to_utf16_binding(diagnostics.clone(), "áx")
        .unwrap();
    let batch =
      diagnostic_events_to_utf16_binding(&diagnostics.events, "áx").unwrap();

    assert_eq!(batch, full);
  }

  #[test]
  fn prepared_search_compressed_package_roundtrips_config_and_artifacts() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_package_to_compressed_bytes(&config, artifacts).unwrap();
    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(
      package_version(&bytes, PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER),
      PREPARED_SEARCH_COMPRESSED_PACKAGE_VERSION
    );
    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_compressed_package_reads_legacy_zstd_digest() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_package_payload_to_bytes(&config, artifacts).unwrap();
    let bytes = zstd_compressed_digest_package(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_ZSTD_VERSION,
      &payload,
    );

    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_compressed_package_reads_legacy_payload_digest() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_package_payload_to_bytes(&config, artifacts).unwrap();
    let bytes = zstd_compressed_package(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
      &payload,
    );

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
    compact_config.search.literal_patterns.clear();
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
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, artifacts)
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(
      package_version(&bytes, PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER),
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_VERSION
    );
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_core_compressed_package_reads_legacy_zstd_digest() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_core_package_payload_to_bytes(&config, artifacts)
        .unwrap();
    let bytes = zstd_compressed_digest_package(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_ZSTD_VERSION,
      &payload,
    );

    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_core_compressed_package_reports_decode_timings() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, artifacts)
        .unwrap();
    let (package, timings) =
      prepared_search_core_package_view_from_bytes_with_timings(&bytes)
        .unwrap();

    assert!(matches!(
      &package.artifacts.inner,
      CorePreparedSearchPackageArtifactsInner::OwnedPayload { .. }
    ));
    assert!(
      timings.verify.is_some(),
      "compressed package digest timing should be reported"
    );
    assert!(
      timings.decompress.is_some(),
      "compressed package decompression timing should be reported"
    );
    assert!(
      timings.config_decode.is_some(),
      "core config decode timing should be reported"
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_decodes_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifact_set = PreparedEngineArtifacts::default();
    let artifact_bytes = artifact_set.to_bytes().unwrap();

    let bytes = prepared_search_core_package_to_compressed_bytes(
      &config,
      &artifact_bytes,
    )
    .unwrap();
    let decoded =
      prepared_search_core_package_decode_from_bytes_with_timings(&bytes)
        .unwrap();

    assert_eq!(decoded.config.search.literal_patterns, Vec::new());
    assert_eq!(decoded.artifacts, artifact_set);
    assert_eq!(decoded.artifacts_bytes, artifact_bytes.len());
    assert!(
      decoded.package_decode_timings.verify.is_some(),
      "compressed package digest timing should be reported"
    );
    assert!(
      decoded.package_decode_timings.decompress.is_some(),
      "compressed package decompression timing should be reported"
    );
    assert!(
      decoded.package_decode_timings.config_decode.is_some(),
      "core config decode timing should be reported"
    );
  }

  #[test]
  fn prepared_search_core_trusted_decode_skips_package_digest() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifact_set = PreparedEngineArtifacts::default();
    let artifact_bytes = artifact_set.to_bytes().unwrap();

    let mut bytes = prepared_search_core_package_to_compressed_bytes(
      &config,
      &artifact_bytes,
    )
    .unwrap();
    let digest_start = PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER
      .len()
      .saturating_add(std::mem::size_of::<u32>());
    let digest_byte = bytes.get_mut(digest_start).unwrap();
    *digest_byte ^= 0xff;

    let verified =
      prepared_search_core_package_decode_from_bytes_with_timings(&bytes);
    assert!(
      verified.is_err(),
      "verified decode must reject a package digest mismatch"
    );

    let trusted =
      prepared_search_core_package_decode_trusted_from_bytes_with_timings(
        &bytes,
      )
      .unwrap();
    assert_eq!(trusted.config.search.literal_patterns, Vec::new());
    assert_eq!(trusted.artifacts, artifact_set);
    assert_eq!(trusted.artifacts_bytes, artifact_bytes.len());
    assert!(
      trusted.package_decode_timings.verify.is_none(),
      "trusted decode should not spend time verifying the package digest"
    );
    assert!(
      trusted.package_decode_timings.decompress.is_some(),
      "trusted decode still has to decompress compressed packages"
    );

    let (trusted_view, trusted_view_timings) =
      prepared_search_core_package_view_trusted_from_bytes_with_timings(&bytes)
        .unwrap();
    assert_eq!(trusted_view.config.search.literal_patterns, Vec::new());
    assert_eq!(trusted_view.artifacts.as_bytes(), artifact_bytes.as_slice());
    assert!(
      trusted_view_timings.verify.is_none(),
      "trusted view decode should not spend time verifying the package digest"
    );
    assert!(
      trusted_view_timings.decompress.is_some(),
      "trusted view decode still has to decompress compressed packages"
    );
  }

  #[test]
  fn prepared_search_core_package_compacts_deny_list_originals() {
    let binding_config = BindingPreparedSearchConfig {
      deny_list_data: Some(BindingDenyListMatchData {
        labels: vec![
          vec![String::from("person")],
          vec![String::from("matter")],
        ],
        custom_labels: vec![Vec::new(), vec![String::from("matter")]],
        originals: vec![String::from("VAT"), String::from("Secret Code")],
        sources: vec![
          vec![String::from("deny-list")],
          vec![String::from("custom-deny-list")],
        ],
        filters: None,
        ..BindingDenyListMatchData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let config = prepared_search_config_from_binding(binding_config).unwrap();

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();
    let data = package.config.detectors.deny_list_data.unwrap();

    assert!(data.originals.is_empty());
    assert_eq!(data.pattern_meta.len(), 2);
    let first = data.pattern_meta.first().unwrap();
    let second = data.pattern_meta.get(1).unwrap();
    assert!(first.has_alphanumeric);
    assert!(first.short_upper_acronym);
    assert!(second.has_alphanumeric);
    assert!(!second.short_upper_acronym);
  }

  #[test]
  fn prepared_search_core_compressed_package_reads_legacy_payload_digest() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_core_package_payload_to_bytes(&config, artifacts)
        .unwrap();
    let bytes = zstd_compressed_package(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_PAYLOAD_DIGEST_VERSION,
      &payload,
    );

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
        prefilter_window_bytes: None,
        prepared_artifact_policy: None,
      }],
      ..BindingPreparedSearchConfig::default()
    }
  }

  fn zstd_compressed_package(
    header: [u8; 8],
    version: u32,
    payload: &[u8],
  ) -> Vec<u8> {
    let compressed =
      zstd::bulk::compress(payload, PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL)
        .unwrap();
    let digest = blake3::hash(payload);
    let mut bytes = Vec::new();
    write_package_header(&mut bytes, header, version, digest.as_bytes());
    let payload_len = u64::try_from(payload.len()).unwrap();
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(&compressed);
    bytes
  }

  fn zstd_compressed_digest_package(
    header: [u8; 8],
    version: u32,
    payload: &[u8],
  ) -> Vec<u8> {
    let compressed =
      zstd::bulk::compress(payload, PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL)
        .unwrap();
    let digest = blake3::hash(&compressed);
    let mut bytes = Vec::new();
    write_package_header(&mut bytes, header, version, digest.as_bytes());
    let payload_len = u64::try_from(payload.len()).unwrap();
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(&compressed);
    bytes
  }

  fn package_version(bytes: &[u8], header: [u8; 8]) -> u32 {
    let version_start = header.len();
    let version_end = version_start.saturating_add(std::mem::size_of::<u32>());
    let version_bytes = bytes.get(version_start..version_end).unwrap();
    u32::from_le_bytes(<[u8; 4]>::try_from(version_bytes).unwrap())
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
