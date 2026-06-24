use std::collections::BTreeMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use stella_anonymize_adapter_contract::{
  BindingCountryMatchData, BindingDenyListFilterData, BindingDenyListMatchData,
  BindingGazetteerMatchData, BindingOperatorConfig, BindingOperatorEntry,
  BindingPatternSlice, BindingPreparedSearchConfig,
  BindingPreparedSearchSlices, BindingRedactionResult, BindingRegexMatchMeta,
  BindingSearchOptions, BindingSearchPattern, BindingStaticRedactionResult,
  ContractError, operator_config_from_binding,
  prepared_search_config_from_binding,
  static_redaction_diagnostic_result_to_binding,
  static_redaction_diagnostics_to_binding, static_redaction_result_to_binding,
};
use stella_anonymize_core::{PreparedSearch, StaticRedactionDiagnostics};

#[napi(object)]
pub struct JsSearchPattern {
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
  pub min_byte_length: Option<u32>,
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
pub struct JsDenyListMatchData {
  pub labels: Vec<Vec<String>>,
  pub custom_labels: Vec<Vec<String>>,
  pub originals: Vec<String>,
  pub sources: Vec<Vec<String>>,
  pub filters: Option<JsDenyListFilterData>,
}

#[napi(object)]
pub struct JsDenyListFilterData {
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
  pub deny_list_data: Option<JsDenyListMatchData>,
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
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  let config =
    serde_json::from_str::<BindingPreparedSearchConfig>(&config_json)
      .map_err(|error| to_napi_serde_error(&error))?;
  let operators = operators_json
    .as_deref()
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_napi_serde_error(&error))?;
  let prepared = PreparedSearch::new(
    prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?,
  )
  .map_err(|error| to_napi_core_error(&error))?;
  let result = prepared
    .redact_static_entities(
      &full_text,
      &operator_config_from_binding(operators)
        .map_err(|error| to_napi_contract_error(&error))?,
    )
    .map(static_redaction_result_to_binding)
    .map_err(|error| to_napi_core_error(&error))?;

  serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_diagnostics_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  let config =
    serde_json::from_str::<BindingPreparedSearchConfig>(&config_json)
      .map_err(|error| to_napi_serde_error(&error))?;
  let operators = operators_json
    .as_deref()
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_napi_serde_error(&error))?;
  let prepared = PreparedSearch::new_with_diagnostics(
    prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?,
  )
  .map_err(|error| to_napi_core_error(&error))?;
  let mut diagnostics = prepared.diagnostics;
  let mut result = prepared
    .prepared
    .redact_static_entities_with_diagnostics(
      &full_text,
      &operator_config_from_binding(operators)
        .map_err(|error| to_napi_contract_error(&error))?,
    )
    .map_err(|error| to_napi_core_error(&error))?;
  diagnostics.extend(result.diagnostics);
  result.diagnostics = diagnostics;
  let result = static_redaction_diagnostic_result_to_binding(result);

  serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
}

#[napi]
pub struct NativePreparedSearch {
  inner: PreparedSearch,
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[napi]
impl NativePreparedSearch {
  #[napi(constructor)]
  pub fn new(config: JsPreparedSearchConfig) -> Result<Self> {
    let config = prepared_search_config_from_binding(to_binding_config(config))
      .map_err(|error| to_napi_contract_error(&error))?;
    let result = PreparedSearch::new_with_diagnostics(config)
      .map_err(|error| to_napi_core_error(&error))?;
    Ok(Self {
      inner: result.prepared,
      prepare_diagnostics: result.diagnostics,
    })
  }

  #[napi]
  pub fn prepare_diagnostics_json(&self) -> Result<String> {
    let diagnostics =
      static_redaction_diagnostics_to_binding(self.prepare_diagnostics.clone());

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_napi_serde_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<JsStaticRedactionResult> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    self
      .inner
      .redact_static_entities(&full_text, &operators)
      .map(static_redaction_result_to_binding)
      .map(to_js_static_redaction_result)
      .map_err(|error| to_napi_core_error(&error))?
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_diagnostics_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    let result = self
      .inner
      .redact_static_entities_with_diagnostics(&full_text, &operators)
      .map(static_redaction_diagnostic_result_to_binding)
      .map_err(|error| to_napi_core_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }
}

fn to_binding_config(
  config: JsPreparedSearchConfig,
) -> BindingPreparedSearchConfig {
  BindingPreparedSearchConfig {
    regex_patterns: to_binding_patterns(config.regex_patterns),
    custom_regex_patterns: to_binding_patterns(config.custom_regex_patterns),
    literal_patterns: to_binding_patterns(config.literal_patterns),
    regex_options: config.regex_options.as_ref().map(to_binding_options),
    custom_regex_options: config
      .custom_regex_options
      .as_ref()
      .map(to_binding_options),
    literal_options: config.literal_options.as_ref().map(to_binding_options),
    slices: to_binding_slices(&config.slices),
    regex_meta: to_binding_regex_meta(config.regex_meta),
    custom_regex_meta: to_binding_regex_meta(config.custom_regex_meta),
    deny_list_data: config.deny_list_data.map(|data| {
      BindingDenyListMatchData {
        labels: data.labels,
        custom_labels: data.custom_labels,
        originals: data.originals,
        sources: data.sources,
        filters: data.filters.map(to_binding_deny_list_filters),
      }
    }),
    gazetteer_data: config.gazetteer_data.map(|data| {
      BindingGazetteerMatchData {
        labels: data.labels,
        is_fuzzy: data.is_fuzzy,
      }
    }),
    country_data: config.country_data.map(|data| BindingCountryMatchData {
      labels: data.labels,
    }),
  }
}

fn to_binding_deny_list_filters(
  filters: JsDenyListFilterData,
) -> BindingDenyListFilterData {
  BindingDenyListFilterData {
    stopwords: filters.stopwords,
    allow_list: filters.allow_list,
    person_stopwords: filters.person_stopwords,
    address_stopwords: filters.address_stopwords,
    street_types: filters.street_types,
    first_names: filters.first_names,
    generic_roles: filters.generic_roles,
    sentence_starters: filters.sentence_starters,
    trailing_address_word_exclusions: filters.trailing_address_word_exclusions,
    defined_term_cues: filters.defined_term_cues,
  }
}

fn to_binding_patterns(
  patterns: Vec<JsSearchPattern>,
) -> Vec<BindingSearchPattern> {
  patterns
    .into_iter()
    .map(|pattern| BindingSearchPattern {
      kind: pattern.kind,
      pattern: pattern.pattern,
      distance: pattern.distance,
      case_insensitive: pattern.case_insensitive,
      whole_words: pattern.whole_words,
      lazy: pattern.lazy,
      prefilter_any: pattern.prefilter_any,
      prefilter_case_insensitive: pattern.prefilter_case_insensitive,
      prefilter_regex: pattern.prefilter_regex,
    })
    .collect()
}

const fn to_binding_options(options: &JsSearchOptions) -> BindingSearchOptions {
  BindingSearchOptions {
    literal_case_insensitive: options.literal_case_insensitive,
    literal_whole_words: options.literal_whole_words,
    regex_whole_words: options.regex_whole_words,
    fuzzy_case_insensitive: options.fuzzy_case_insensitive,
    fuzzy_whole_words: options.fuzzy_whole_words,
    fuzzy_normalize_diacritics: options.fuzzy_normalize_diacritics,
  }
}

fn to_binding_slices(
  slices: &JsPreparedSearchSlices,
) -> BindingPreparedSearchSlices {
  BindingPreparedSearchSlices {
    regex: slices.regex.as_ref().map(to_binding_slice),
    custom_regex: slices.custom_regex.as_ref().map(to_binding_slice),
    legal_forms: slices.legal_forms.as_ref().map(to_binding_slice),
    triggers: slices.triggers.as_ref().map(to_binding_slice),
    deny_list: slices.deny_list.as_ref().map(to_binding_slice),
    street_types: slices.street_types.as_ref().map(to_binding_slice),
    gazetteer: slices.gazetteer.as_ref().map(to_binding_slice),
    countries: slices.countries.as_ref().map(to_binding_slice),
  }
}

const fn to_binding_slice(slice: &JsPatternSlice) -> BindingPatternSlice {
  BindingPatternSlice {
    start: slice.start,
    end: slice.end,
  }
}

fn to_binding_regex_meta(
  meta: Vec<JsRegexMatchMeta>,
) -> Vec<BindingRegexMatchMeta> {
  meta
    .into_iter()
    .map(|entry| BindingRegexMatchMeta {
      label: entry.label,
      score: entry.score,
      source_detail: entry.source_detail,
      requires_validation: entry.requires_validation,
      min_byte_length: entry.min_byte_length,
    })
    .collect()
}

fn to_binding_operator_config(
  config: JsOperatorConfig,
) -> BindingOperatorConfig {
  BindingOperatorConfig {
    operators: config.operators,
    redact_string: config.redact_string,
  }
}

fn to_js_static_redaction_result(
  result: BindingStaticRedactionResult,
) -> Result<JsStaticRedactionResult> {
  Ok(JsStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| JsPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: entity.source,
        source_detail: entity.source_detail,
      })
      .collect(),
    redaction: to_js_redaction_result(result.redaction)?,
  })
}

fn to_js_redaction_result(
  result: BindingRedactionResult,
) -> Result<JsRedactionResult> {
  Ok(JsRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(|entry| JsRedactionEntry {
        placeholder: entry.placeholder,
        original: entry.original,
      })
      .collect(),
    operator_map: to_js_operator_entries(result.operator_map),
    entity_count: u32::try_from(result.entity_count).map_err(|_| {
      Error::from_reason(format!(
        "Entity count exceeds u32 range: {}",
        result.entity_count
      ))
    })?,
  })
}

fn to_js_operator_entries(
  entries: Vec<BindingOperatorEntry>,
) -> Vec<JsOperatorEntry> {
  entries
    .into_iter()
    .map(|entry| JsOperatorEntry {
      placeholder: entry.placeholder,
      operator: entry.operator,
    })
    .collect()
}

fn to_napi_core_error(error: &stella_anonymize_core::Error) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_contract_error(error: &ContractError) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_serde_error(error: &serde_json::Error) -> Error {
  Error::from_reason(error.to_string())
}
