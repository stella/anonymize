use std::collections::BTreeMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use stella_anonymize_core::{
  CountryMatchData, DetectionSource, FuzzySearchOptions, GazetteerMatchData,
  LiteralSearchOptions, OperatorConfig, OperatorType, PatternSlice,
  PreparedSearch, PreparedSearchConfig, PreparedSearchSlices, RegexMatchMeta,
  RegexSearchOptions, SearchOptions, SearchPattern, SourceDetail,
  StaticRedactionResult,
};

#[napi(object)]
pub struct JsSearchPattern {
  pub kind: String,
  pub pattern: String,
  pub distance: Option<u32>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
}

#[napi(object)]
pub struct JsSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[napi(object)]
pub struct JsPatternSlice {
  pub start: u32,
  pub end: u32,
}

#[napi(object)]
pub struct JsPreparedSearchSlices {
  pub regex: Option<JsPatternSlice>,
  pub custom_regex: Option<JsPatternSlice>,
  pub legal_forms: Option<JsPatternSlice>,
  pub triggers: Option<JsPatternSlice>,
  pub deny_list: Option<JsPatternSlice>,
  pub street_types: Option<JsPatternSlice>,
  pub gazetteer: Option<JsPatternSlice>,
  pub countries: Option<JsPatternSlice>,
}

#[napi(object)]
pub struct JsRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
}

#[napi(object)]
pub struct JsGazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[napi(object)]
pub struct JsCountryMatchData {
  pub labels: Vec<String>,
}

#[napi(object)]
pub struct JsPreparedSearchConfig {
  pub regex_patterns: Vec<JsSearchPattern>,
  pub custom_regex_patterns: Vec<JsSearchPattern>,
  pub literal_patterns: Vec<JsSearchPattern>,
  pub regex_options: Option<JsSearchOptions>,
  pub custom_regex_options: Option<JsSearchOptions>,
  pub literal_options: Option<JsSearchOptions>,
  pub slices: JsPreparedSearchSlices,
  pub regex_meta: Vec<JsRegexMatchMeta>,
  pub custom_regex_meta: Vec<JsRegexMatchMeta>,
  pub gazetteer_data: Option<JsGazetteerMatchData>,
  pub country_data: Option<JsCountryMatchData>,
}

#[napi(object)]
pub struct JsOperatorConfig {
  pub operators: Option<BTreeMap<String, String>>,
  pub redact_string: Option<String>,
}

#[napi(object)]
pub struct JsRedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[napi(object)]
pub struct JsOperatorEntry {
  pub placeholder: String,
  pub operator: String,
}

#[napi(object)]
pub struct JsRedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<JsRedactionEntry>,
  pub operator_map: Vec<JsOperatorEntry>,
  pub entity_count: u32,
}

#[napi(object)]
pub struct JsPipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: String,
  pub source_detail: Option<String>,
}

#[napi(object)]
pub struct JsStaticRedactionResult {
  pub resolved_entities: Vec<JsPipelineEntity>,
  pub redaction: JsRedactionResult,
}

#[napi]
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn normalize_for_search(text: String) -> String {
  stella_anonymize_core::normalize_for_search(&text)
}

#[napi]
pub struct NativePreparedSearch {
  inner: PreparedSearch,
}

#[napi]
impl NativePreparedSearch {
  #[napi(constructor)]
  pub fn new(config: JsPreparedSearchConfig) -> Result<Self> {
    PreparedSearch::new(to_prepared_search_config(config)?)
      .map(|inner| Self { inner })
      .map_err(|error| to_napi_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<JsStaticRedactionResult> {
    let operator_config = to_operator_config(operators)?;
    self
      .inner
      .redact_static_entities(&full_text, &operator_config)
      .map(to_static_redaction_result)
      .map_err(|error| to_napi_error(&error))
  }
}

fn to_prepared_search_config(
  config: JsPreparedSearchConfig,
) -> Result<PreparedSearchConfig> {
  Ok(PreparedSearchConfig {
    regex_patterns: to_search_patterns(config.regex_patterns)?,
    custom_regex_patterns: to_search_patterns(config.custom_regex_patterns)?,
    literal_patterns: to_search_patterns(config.literal_patterns)?,
    regex_options: to_search_options(config.regex_options),
    custom_regex_options: to_search_options(config.custom_regex_options),
    literal_options: to_search_options(config.literal_options),
    slices: to_slices(config.slices),
    regex_meta: to_regex_meta(config.regex_meta),
    custom_regex_meta: to_regex_meta(config.custom_regex_meta),
    gazetteer_data: config.gazetteer_data.map(|data| GazetteerMatchData {
      labels: data.labels,
      is_fuzzy: data.is_fuzzy,
    }),
    country_data: config.country_data.map(|data| CountryMatchData {
      labels: data.labels,
    }),
  })
}

fn to_search_patterns(
  patterns: Vec<JsSearchPattern>,
) -> Result<Vec<SearchPattern>> {
  patterns
    .into_iter()
    .map(|pattern| match pattern.kind.as_str() {
      "literal" => Ok(SearchPattern::Literal(pattern.pattern)),
      "literal-with-options" => Ok(SearchPattern::LiteralWithOptions {
        pattern: pattern.pattern,
        case_insensitive: pattern.case_insensitive,
        whole_words: pattern.whole_words,
      }),
      "regex" => Ok(SearchPattern::Regex(pattern.pattern)),
      "fuzzy" => Ok(SearchPattern::Fuzzy {
        pattern: pattern.pattern,
        distance: pattern
          .distance
          .map(|distance| {
            u8::try_from(distance).map_err(|_| {
              Error::from_reason(format!(
                "Fuzzy distance exceeds u8 range: {distance}"
              ))
            })
          })
          .transpose()?,
      }),
      _ => Err(Error::from_reason(format!(
        "Unsupported search pattern kind: {}",
        pattern.kind
      ))),
    })
    .collect()
}

fn to_search_options(options: Option<JsSearchOptions>) -> SearchOptions {
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

fn to_slices(slices: JsPreparedSearchSlices) -> PreparedSearchSlices {
  PreparedSearchSlices {
    regex: to_slice(slices.regex),
    custom_regex: to_slice(slices.custom_regex),
    legal_forms: to_slice(slices.legal_forms),
    triggers: to_slice(slices.triggers),
    deny_list: to_slice(slices.deny_list),
    street_types: to_slice(slices.street_types),
    gazetteer: to_slice(slices.gazetteer),
    countries: to_slice(slices.countries),
  }
}

fn to_slice(slice: Option<JsPatternSlice>) -> PatternSlice {
  slice.map_or_else(PatternSlice::default, |slice| PatternSlice {
    start: slice.start,
    end: slice.end,
  })
}

fn to_regex_meta(meta: Vec<JsRegexMatchMeta>) -> Vec<RegexMatchMeta> {
  meta
    .into_iter()
    .map(|entry| RegexMatchMeta {
      label: entry.label,
      score: entry.score,
      source_detail: entry.source_detail.as_deref().and_then(to_source_detail),
      requires_validation: entry.requires_validation.unwrap_or(false),
    })
    .collect()
}

fn to_source_detail(value: &str) -> Option<SourceDetail> {
  match value {
    "custom-deny-list" => Some(SourceDetail::CustomDenyList),
    "custom-regex" => Some(SourceDetail::CustomRegex),
    "gazetteer-extension" => Some(SourceDetail::GazetteerExtension),
    _ => None,
  }
}

fn to_operator_config(
  config: Option<JsOperatorConfig>,
) -> Result<OperatorConfig> {
  let Some(config) = config else {
    return Ok(OperatorConfig::default());
  };

  let mut operators = BTreeMap::new();
  for (label, value) in config.operators.unwrap_or_default() {
    operators.insert(label, to_operator_type(&value)?);
  }

  Ok(OperatorConfig {
    operators,
    redact_string: config
      .redact_string
      .unwrap_or_else(|| String::from("[REDACTED]")),
  })
}

fn to_operator_type(value: &str) -> Result<OperatorType> {
  match value {
    "replace" => Ok(OperatorType::Replace),
    "redact" => Ok(OperatorType::Redact),
    _ => Err(Error::from_reason(format!(
      "Unsupported anonymization operator: {value}"
    ))),
  }
}

fn to_static_redaction_result(
  result: StaticRedactionResult,
) -> JsStaticRedactionResult {
  JsStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| JsPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: detection_source_name(entity.source),
        source_detail: entity.source_detail.map(source_detail_name),
      })
      .collect(),
    redaction: JsRedactionResult {
      redacted_text: result.redaction.redacted_text,
      redaction_map: result
        .redaction
        .redaction_map
        .into_iter()
        .map(|entry| JsRedactionEntry {
          placeholder: entry.placeholder,
          original: entry.original,
        })
        .collect(),
      operator_map: result
        .redaction
        .operator_map
        .into_iter()
        .map(|entry| JsOperatorEntry {
          placeholder: entry.placeholder,
          operator: operator_name(entry.operator),
        })
        .collect(),
      entity_count: u32::try_from(result.redaction.entity_count)
        .unwrap_or(u32::MAX),
    },
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

fn operator_name(operator: OperatorType) -> String {
  match operator {
    OperatorType::Replace => "replace",
    OperatorType::Redact => "redact",
  }
  .to_owned()
}

fn to_napi_error(error: &stella_anonymize_core::Error) -> Error {
  Error::from_reason(error.to_string())
}
