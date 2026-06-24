use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use stella_anonymize_adapter_contract::{
  BindingOperatorConfig, BindingOperatorEntry, BindingPipelineEntity,
  BindingPreparedSearchConfig, BindingRedactionEntry, BindingRedactionResult,
  BindingStaticRedactionResult, ContractError, operator_config_from_binding,
  prepared_search_config_from_binding, static_redaction_result_to_binding,
};
use stella_anonymize_core::PreparedSearch as CorePreparedSearch;

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
    let config = parse_prepared_search_config(config_json)?;
    let inner = CorePreparedSearch::new(
      prepared_search_config_from_binding(config)
        .map_err(|error| to_py_contract_error(&error))?,
    )
    .map_err(|error| to_py_core_error(&error))?;
    Ok(Self { inner })
  }

  fn redact_static_entities(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let operators = parse_operator_config(operators_json)?;
    self
      .inner
      .redact_static_entities(
        full_text,
        &operator_config_from_binding(operators)
          .map_err(|error| to_py_contract_error(&error))?,
      )
      .map(static_redaction_result_to_binding)
      .map(to_py_static_redaction_result)
      .map_err(|error| to_py_core_error(&error))
  }

  fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result = self.redact_static_entities(full_text, operators_json)?;
    serde_json::to_string(&to_binding_static_redaction_result(result))
      .map_err(|error| to_py_serde_error(&error))
  }
}

#[pyfunction]
fn redact_static_entities_json(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared.redact_static_entities_json(full_text, operators_json)
}

#[pyfunction]
fn normalize_for_search(text: &str) -> String {
  stella_anonymize_core::normalize_for_search(text)
}

fn parse_prepared_search_config(
  config_json: &str,
) -> PyResult<BindingPreparedSearchConfig> {
  serde_json::from_str(config_json).map_err(|error| to_py_serde_error(&error))
}

fn parse_operator_config(
  operators_json: Option<&str>,
) -> PyResult<Option<BindingOperatorConfig>> {
  operators_json
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_py_serde_error(&error))
}

fn to_py_static_redaction_result(
  result: BindingStaticRedactionResult,
) -> PyStaticRedactionResult {
  PyStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(to_py_pipeline_entity)
      .collect(),
    redaction: to_py_redaction_result(result.redaction),
  }
}

fn to_py_pipeline_entity(entity: BindingPipelineEntity) -> PyPipelineEntity {
  PyPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: entity.source,
    source_detail: entity.source_detail,
  }
}

fn to_py_redaction_result(result: BindingRedactionResult) -> PyRedactionResult {
  PyRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(to_py_redaction_entry)
      .collect(),
    operator_map: result
      .operator_map
      .into_iter()
      .map(to_py_operator_entry)
      .collect(),
    entity_count: result.entity_count,
  }
}

fn to_py_redaction_entry(entry: BindingRedactionEntry) -> PyRedactionEntry {
  PyRedactionEntry {
    placeholder: entry.placeholder,
    original: entry.original,
  }
}

fn to_py_operator_entry(entry: BindingOperatorEntry) -> PyOperatorEntry {
  PyOperatorEntry {
    placeholder: entry.placeholder,
    operator: entry.operator,
  }
}

fn to_binding_static_redaction_result(
  result: PyStaticRedactionResult,
) -> BindingStaticRedactionResult {
  BindingStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(to_binding_pipeline_entity)
      .collect(),
    redaction: to_binding_redaction_result(result.redaction),
  }
}

fn to_binding_pipeline_entity(
  entity: PyPipelineEntity,
) -> BindingPipelineEntity {
  BindingPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: entity.source,
    source_detail: entity.source_detail,
  }
}

fn to_binding_redaction_result(
  result: PyRedactionResult,
) -> BindingRedactionResult {
  BindingRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(to_binding_redaction_entry)
      .collect(),
    operator_map: result
      .operator_map
      .into_iter()
      .map(to_binding_operator_entry)
      .collect(),
    entity_count: result.entity_count,
  }
}

fn to_binding_redaction_entry(
  entry: PyRedactionEntry,
) -> BindingRedactionEntry {
  BindingRedactionEntry {
    placeholder: entry.placeholder,
    original: entry.original,
  }
}

fn to_binding_operator_entry(entry: PyOperatorEntry) -> BindingOperatorEntry {
  BindingOperatorEntry {
    placeholder: entry.placeholder,
    operator: entry.operator,
  }
}

fn to_py_core_error(error: &stella_anonymize_core::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_contract_error(error: &ContractError) -> PyErr {
  PyValueError::new_err(error.to_string())
}

fn to_py_serde_error(error: &serde_json::Error) -> PyErr {
  PyValueError::new_err(error.to_string())
}

#[pymodule(gil_used = false)]
fn stella_anonymize_core_py(module: &Bound<'_, PyModule>) -> PyResult<()> {
  module.add_class::<PyPreparedSearch>()?;
  module.add_class::<PyStaticRedactionResult>()?;
  module.add_class::<PyRedactionResult>()?;
  module.add_class::<PyRedactionEntry>()?;
  module.add_class::<PyOperatorEntry>()?;
  module.add_class::<PyPipelineEntity>()?;
  module
    .add_function(wrap_pyfunction!(redact_static_entities_json, module)?)?;
  module.add_function(wrap_pyfunction!(normalize_for_search, module)?)?;
  Ok(())
}
