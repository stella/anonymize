use std::collections::BTreeMap;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use serde::Deserialize;
use stella_anonymize_core::{
  CountryMatchData, DetectionSource, FuzzySearchOptions, GazetteerMatchData,
  LiteralSearchOptions, OperatorConfig, OperatorType, PatternSlice,
  PreparedSearch as CorePreparedSearch, PreparedSearchConfig,
  PreparedSearchSlices, RegexMatchMeta, RegexSearchOptions, SearchOptions,
  SearchPattern, SourceDetail, StaticRedactionResult,
};

#[derive(Deserialize)]
struct SearchPatternDto {
  kind: String,
  pattern: String,
  distance: Option<u32>,
  case_insensitive: Option<bool>,
  whole_words: Option<bool>,
}

#[derive(Deserialize)]
struct SearchOptionsDto {
  literal_case_insensitive: Option<bool>,
  literal_whole_words: Option<bool>,
  regex_whole_words: Option<bool>,
  fuzzy_case_insensitive: Option<bool>,
  fuzzy_whole_words: Option<bool>,
  fuzzy_normalize_diacritics: Option<bool>,
}

#[derive(Deserialize)]
struct PatternSliceDto {
  start: u32,
  end: u32,
}

#[derive(Deserialize)]
struct PreparedSearchSlicesDto {
  regex: Option<PatternSliceDto>,
  custom_regex: Option<PatternSliceDto>,
  legal_forms: Option<PatternSliceDto>,
  triggers: Option<PatternSliceDto>,
  deny_list: Option<PatternSliceDto>,
  street_types: Option<PatternSliceDto>,
  gazetteer: Option<PatternSliceDto>,
  countries: Option<PatternSliceDto>,
}

#[derive(Deserialize)]
struct RegexMatchMetaDto {
  label: String,
  score: f64,
  source_detail: Option<String>,
  requires_validation: Option<bool>,
}

#[derive(Deserialize)]
struct GazetteerMatchDataDto {
  labels: Vec<String>,
  is_fuzzy: Vec<bool>,
}

#[derive(Deserialize)]
struct CountryMatchDataDto {
  labels: Vec<String>,
}

#[derive(Deserialize)]
struct PreparedSearchConfigDto {
  regex_patterns: Vec<SearchPatternDto>,
  custom_regex_patterns: Vec<SearchPatternDto>,
  literal_patterns: Vec<SearchPatternDto>,
  regex_options: Option<SearchOptionsDto>,
  custom_regex_options: Option<SearchOptionsDto>,
  literal_options: Option<SearchOptionsDto>,
  slices: PreparedSearchSlicesDto,
  regex_meta: Vec<RegexMatchMetaDto>,
  custom_regex_meta: Vec<RegexMatchMetaDto>,
  gazetteer_data: Option<GazetteerMatchDataDto>,
  country_data: Option<CountryMatchDataDto>,
}

#[derive(Default, Deserialize)]
struct OperatorConfigDto {
  operators: Option<BTreeMap<String, String>>,
  redact_string: Option<String>,
}

#[pyclass(name = "RedactionEntry", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyRedactionEntry {
  placeholder: String,
  original: String,
}

#[pyclass(name = "OperatorEntry", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyOperatorEntry {
  placeholder: String,
  operator: String,
}

#[pyclass(name = "RedactionResult", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyRedactionResult {
  redacted_text: String,
  redaction_map: Vec<PyRedactionEntry>,
  operator_map: Vec<PyOperatorEntry>,
  entity_count: usize,
}

#[pyclass(name = "PipelineEntity", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyPipelineEntity {
  start: u32,
  end: u32,
  label: String,
  text: String,
  score: f64,
  source: String,
  source_detail: Option<String>,
}

#[pyclass(name = "StaticRedactionResult", get_all, skip_from_py_object)]
#[derive(Clone)]
pub struct PyStaticRedactionResult {
  resolved_entities: Vec<PyPipelineEntity>,
  redaction: PyRedactionResult,
}

#[pyclass(name = "PreparedSearch")]
pub struct PyPreparedSearch {
  inner: CorePreparedSearch,
}

#[pymethods]
impl PyPreparedSearch {
  #[new]
  fn new(config_json: &str) -> PyResult<Self> {
    let config: PreparedSearchConfigDto = serde_json::from_str(config_json)
      .map_err(|error| to_py_value_error(&error))?;
    let inner = CorePreparedSearch::new(to_prepared_search_config(config)?)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(Self { inner })
  }

  fn redact_static_entities(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let operators = to_operator_config(operators_json)?;
    self
      .inner
      .redact_static_entities(full_text, &operators)
      .map(to_static_redaction_result)
      .map_err(|error| to_py_core_error(&error))
  }
}

#[pyfunction]
fn normalize_for_search(text: &str) -> String {
  stella_anonymize_core::normalize_for_search(text)
}

fn to_prepared_search_config(
  config: PreparedSearchConfigDto,
) -> PyResult<PreparedSearchConfig> {
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
  patterns: Vec<SearchPatternDto>,
) -> PyResult<Vec<SearchPattern>> {
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
              PyValueError::new_err(format!(
                "Fuzzy distance exceeds u8 range: {distance}"
              ))
            })
          })
          .transpose()?,
      }),
      _ => Err(PyValueError::new_err(format!(
        "Unsupported search pattern kind: {}",
        pattern.kind
      ))),
    })
    .collect()
}

fn to_search_options(options: Option<SearchOptionsDto>) -> SearchOptions {
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

fn to_slices(slices: PreparedSearchSlicesDto) -> PreparedSearchSlices {
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

fn to_slice(slice: Option<PatternSliceDto>) -> PatternSlice {
  slice.map_or_else(PatternSlice::default, |slice| PatternSlice {
    start: slice.start,
    end: slice.end,
  })
}

fn to_regex_meta(meta: Vec<RegexMatchMetaDto>) -> Vec<RegexMatchMeta> {
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
  operators_json: Option<&str>,
) -> PyResult<OperatorConfig> {
  let Some(operators_json) = operators_json else {
    return Ok(OperatorConfig::default());
  };
  let config: OperatorConfigDto = serde_json::from_str(operators_json)
    .map_err(|error| to_py_value_error(&error))?;

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

fn to_operator_type(value: &str) -> PyResult<OperatorType> {
  match value {
    "replace" => Ok(OperatorType::Replace),
    "redact" => Ok(OperatorType::Redact),
    _ => Err(PyValueError::new_err(format!(
      "Unsupported anonymization operator: {value}"
    ))),
  }
}

fn to_static_redaction_result(
  result: StaticRedactionResult,
) -> PyStaticRedactionResult {
  PyStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| PyPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: detection_source_name(entity.source),
        source_detail: entity.source_detail.map(source_detail_name),
      })
      .collect(),
    redaction: PyRedactionResult {
      redacted_text: result.redaction.redacted_text,
      redaction_map: result
        .redaction
        .redaction_map
        .into_iter()
        .map(|entry| PyRedactionEntry {
          placeholder: entry.placeholder,
          original: entry.original,
        })
        .collect(),
      operator_map: result
        .redaction
        .operator_map
        .into_iter()
        .map(|entry| PyOperatorEntry {
          placeholder: entry.placeholder,
          operator: operator_name(entry.operator),
        })
        .collect(),
      entity_count: result.redaction.entity_count,
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

fn to_py_core_error(error: &stella_anonymize_core::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_value_error(error: &serde_json::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

#[pymodule]
fn stella_anonymize_core_py(module: &Bound<'_, PyModule>) -> PyResult<()> {
  module.add_class::<PyPreparedSearch>()?;
  module.add_class::<PyStaticRedactionResult>()?;
  module.add_class::<PyRedactionResult>()?;
  module.add_class::<PyRedactionEntry>()?;
  module.add_class::<PyOperatorEntry>()?;
  module.add_class::<PyPipelineEntity>()?;
  module.add_function(wrap_pyfunction!(normalize_for_search, module)?)?;
  Ok(())
}
