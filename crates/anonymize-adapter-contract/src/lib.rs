use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use stella_anonymize_core::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, DetectionSource,
  DiagnosticEvent, DiagnosticEventKind, DiagnosticStage, FuzzySearchOptions,
  GazetteerMatchData, LiteralSearchOptions, OperatorConfig, OperatorType,
  PatternSlice, PreparedSearchConfig, PreparedSearchSlices, RegexMatchMeta,
  RegexSearchOptions, SearchEngine, SearchOptions, SearchPattern, SourceDetail,
  StaticRedactionDiagnosticResult, StaticRedactionDiagnostics,
  StaticRedactionResult,
};

pub type Result<T> = std::result::Result<T, ContractError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
  FuzzyDistanceOutOfRange { distance: u32 },
  UnsupportedOperator { value: String },
  UnsupportedSearchPatternKind { kind: String },
  UnsupportedSourceDetail { value: String },
}

impl std::fmt::Display for ContractError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::FuzzyDistanceOutOfRange { distance } => {
        write!(formatter, "Fuzzy distance exceeds u8 range: {distance}")
      }
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
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BindingRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
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

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingDenyListMatchData {
  pub labels: Vec<Vec<String>>,
  pub custom_labels: Vec<Vec<String>>,
  pub originals: Vec<String>,
  pub sources: Vec<Vec<String>>,
  pub filters: Option<BindingDenyListFilterData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingDenyListFilterData {
  pub stopwords: Vec<String>,
  pub allow_list: Vec<String>,
  pub person_stopwords: Vec<String>,
  pub address_stopwords: Vec<String>,
  pub street_types: Vec<String>,
  pub first_names: Vec<String>,
  pub generic_roles: Vec<String>,
  pub sentence_starters: Vec<String>,
  pub trailing_address_word_exclusions: Vec<String>,
  pub defined_term_cues: Vec<String>,
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
  pub slices: BindingPreparedSearchSlices,
  #[serde(default)]
  pub regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub custom_regex_meta: Vec<BindingRegexMatchMeta>,
  #[serde(default)]
  pub deny_list_data: Option<BindingDenyListMatchData>,
  #[serde(default)]
  pub gazetteer_data: Option<BindingGazetteerMatchData>,
  #[serde(default)]
  pub country_data: Option<BindingCountryMatchData>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingOperatorConfig {
  pub operators: Option<BTreeMap<String, String>>,
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
  Ok(PreparedSearchConfig {
    regex_patterns: search_patterns_from_binding(config.regex_patterns)?,
    custom_regex_patterns: search_patterns_from_binding(
      config.custom_regex_patterns,
    )?,
    literal_patterns: search_patterns_from_binding(config.literal_patterns)?,
    regex_options: search_options_from_binding(config.regex_options),
    custom_regex_options: search_options_from_binding(
      config.custom_regex_options,
    ),
    literal_options: search_options_from_binding(config.literal_options),
    slices: slices_from_binding(&config.slices),
    regex_meta: regex_meta_from_binding(config.regex_meta)?,
    custom_regex_meta: regex_meta_from_binding(config.custom_regex_meta)?,
    deny_list_data: config.deny_list_data.map(|data| DenyListMatchData {
      labels: data.labels,
      custom_labels: data.custom_labels,
      originals: data.originals,
      sources: data.sources,
      filters: data.filters.map(deny_list_filters_from_binding),
    }),
    gazetteer_data: config.gazetteer_data.map(|data| GazetteerMatchData {
      labels: data.labels,
      is_fuzzy: data.is_fuzzy,
    }),
    country_data: config.country_data.map(|data| CountryMatchData {
      labels: data.labels,
    }),
  })
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

#[must_use]
pub fn static_redaction_diagnostic_result_to_binding(
  result: StaticRedactionDiagnosticResult,
) -> BindingStaticRedactionDiagnosticResult {
  BindingStaticRedactionDiagnosticResult {
    result: static_redaction_result_to_binding(result.result),
    diagnostics: static_redaction_diagnostics_to_binding(result.diagnostics),
  }
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

fn deny_list_filters_from_binding(
  filters: BindingDenyListFilterData,
) -> DenyListFilterData {
  DenyListFilterData {
    stopwords: lower_set(filters.stopwords),
    allow_list: lower_set(filters.allow_list),
    person_stopwords: lower_set(filters.person_stopwords),
    address_stopwords: lower_set(filters.address_stopwords),
    street_types: lower_set(filters.street_types),
    first_names: lower_set(filters.first_names),
    generic_roles: lower_set(filters.generic_roles),
    sentence_starters: lower_set(filters.sentence_starters),
    trailing_address_word_exclusions: lower_set(
      filters.trailing_address_word_exclusions,
    ),
    defined_term_cues: lower_set(filters.defined_term_cues),
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
    DiagnosticStage::PrepareTotal => "prepare.total",
    DiagnosticStage::PrepareRegex => "prepare.regex",
    DiagnosticStage::PrepareCustomRegex => "prepare.custom-regex",
    DiagnosticStage::PrepareLiteral => "prepare.literal",
    DiagnosticStage::Normalize => "normalize",
    DiagnosticStage::FindMatches => "find-matches",
    DiagnosticStage::FindRegex => "find.regex",
    DiagnosticStage::FindCustomRegex => "find.custom-regex",
    DiagnosticStage::FindLiteral => "find.literal",
    DiagnosticStage::SearchRegex => "search.regex",
    DiagnosticStage::SearchCustomRegex => "search.custom-regex",
    DiagnosticStage::SearchLiteral => "search.literal",
    DiagnosticStage::EntityRegex => "entity.regex",
    DiagnosticStage::EntityCustomRegex => "entity.custom-regex",
    DiagnosticStage::EntityDenyList => "entity.deny-list",
    DiagnosticStage::EntityGazetteer => "entity.gazetteer",
    DiagnosticStage::EntityCountry => "entity.country",
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
