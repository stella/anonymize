use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use stella_anonymize_adapter_contract::{
  BindingOperatorConfig, BindingOperatorEntry, BindingPipelineEntity,
  BindingPreparedSearchConfig, BindingRedactionEntry, BindingRedactionResult,
  BindingStaticRedactionResult, ContractError, operator_config_from_binding,
  prepared_search_config_from_binding, prepared_search_core_package_to_bytes,
  prepared_search_core_package_to_compressed_bytes,
  prepared_search_core_package_view_from_bytes,
  prepared_search_package_from_bytes, prepared_search_package_has_core_payload,
  static_redaction_diagnostic_result_to_utf16_binding,
  static_redaction_diagnostics_to_binding, static_redaction_result_to_binding,
  static_redaction_result_to_utf16_binding,
};
use stella_anonymize_core::{
  PreparedSearch as CorePreparedSearch, PreparedSearchArtifacts,
  StaticRedactionDiagnostics, StaticRedactionResult,
};

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
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[pymethods]
impl PyPreparedSearch {
  #[new]
  fn new(config_json: &str) -> PyResult<Self> {
    let config = parse_core_prepared_search_config(config_json)?;
    let result = CorePreparedSearch::new_with_diagnostics(config)
      .map_err(|error| to_py_core_error(&error))?;
    Ok(Self {
      inner: result.prepared,
      prepare_diagnostics: result.diagnostics,
    })
  }

  #[staticmethod]
  fn from_config_json_and_artifact_bytes(
    config_json: &str,
    artifact_bytes: &[u8],
  ) -> PyResult<Self> {
    let config = parse_core_prepared_search_config(config_json)?;
    let artifacts = PreparedSearchArtifacts::from_bytes(artifact_bytes)
      .map_err(|error| to_py_core_error(&error))?;
    let result =
      CorePreparedSearch::new_with_artifacts_diagnostics(config, &artifacts)
        .map_err(|error| to_py_core_error(&error))?;
    Ok(Self {
      inner: result.prepared,
      prepare_diagnostics: result.diagnostics,
    })
  }

  #[staticmethod]
  fn from_prepared_package_bytes(package_bytes: &[u8]) -> PyResult<Self> {
    if prepared_search_package_has_core_payload(package_bytes) {
      let package = prepared_search_core_package_view_from_bytes(package_bytes)
        .map_err(|error| to_py_contract_error(&error))?;
      let artifacts =
        PreparedSearchArtifacts::from_bytes(package.artifacts.as_ref())
          .map_err(|error| to_py_core_error(&error))?;
      let result = CorePreparedSearch::new_with_artifacts_diagnostics(
        package.config,
        &artifacts,
      )
      .map_err(|error| to_py_core_error(&error))?;
      return Ok(Self {
        inner: result.prepared,
        prepare_diagnostics: result.diagnostics,
      });
    }

    let package = prepared_search_package_from_bytes(package_bytes)
      .map_err(|error| to_py_contract_error(&error))?;
    let config = prepared_search_config_from_binding(package.config)
      .map_err(|error| to_py_contract_error(&error))?;
    let artifacts = PreparedSearchArtifacts::from_bytes(&package.artifacts)
      .map_err(|error| to_py_core_error(&error))?;
    let result =
      CorePreparedSearch::new_with_artifacts_diagnostics(config, &artifacts)
        .map_err(|error| to_py_core_error(&error))?;
    Ok(Self {
      inner: result.prepared,
      prepare_diagnostics: result.diagnostics,
    })
  }

  fn prepare_diagnostics_json(&self) -> PyResult<String> {
    let diagnostics =
      static_redaction_diagnostics_to_binding(self.prepare_diagnostics.clone());

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_py_serde_error(&error))
  }

  fn warm_lazy_regex(&self) -> PyResult<()> {
    self
      .inner
      .warm_lazy_regex()
      .map_err(|error| to_py_core_error(&error))
  }

  fn redact_static_entities(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<PyStaticRedactionResult> {
    let result = self.redact_static_entities_core(full_text, operators_json)?;
    static_redaction_result_to_python_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))
      .map(to_py_static_redaction_result)
  }

  fn redact_static_entities_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let result = self.redact_static_entities_core(full_text, operators_json)?;
    let result = static_redaction_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_py_contract_error(&error))?;
    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }

  fn redact_static_entities_diagnostics_json(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<String> {
    let operators = parse_operator_config(operators_json)?;
    let mut result = self
      .inner
      .redact_static_entities_with_diagnostics(
        full_text,
        &operator_config_from_binding(operators)
          .map_err(|error| to_py_contract_error(&error))?,
      )
      .map_err(|error| to_py_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result =
      static_redaction_diagnostic_result_to_utf16_binding(result, full_text)
        .map_err(|error| to_py_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_py_serde_error(&error))
  }
}

impl PyPreparedSearch {
  fn redact_static_entities_core(
    &self,
    full_text: &str,
    operators_json: Option<&str>,
  ) -> PyResult<StaticRedactionResult> {
    let operators = parse_operator_config(operators_json)?;
    self
      .inner
      .redact_static_entities(
        full_text,
        &operator_config_from_binding(operators)
          .map_err(|error| to_py_contract_error(&error))?,
      )
      .map_err(|error| to_py_core_error(&error))
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
fn prepare_static_search_artifacts_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  let config = parse_core_prepared_search_config(config_json)?;
  let bytes = CorePreparedSearch::prepare_artifacts(config)
    .and_then(|artifacts| artifacts.to_bytes())
    .map_err(|error| to_py_core_error(&error))?;
  Ok(PyBytes::new(py, &bytes))
}

#[pyfunction]
fn prepare_static_search_package_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  prepare_static_search_package_bytes_with(py, config_json, false)
}

#[pyfunction]
fn prepare_static_search_compressed_package_bytes<'py>(
  py: Python<'py>,
  config_json: &str,
) -> PyResult<Bound<'py, PyBytes>> {
  prepare_static_search_package_bytes_with(py, config_json, true)
}

fn prepare_static_search_package_bytes_with<'py>(
  py: Python<'py>,
  config_json: &str,
  compressed: bool,
) -> PyResult<Bound<'py, PyBytes>> {
  let binding_config = parse_prepared_search_config(config_json)?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_py_contract_error(&error))?;
  let artifacts = CorePreparedSearch::prepare_artifacts(core_config.clone())
    .and_then(|artifacts| artifacts.to_bytes())
    .map_err(|error| to_py_core_error(&error))?;
  let package = if compressed {
    prepared_search_core_package_to_compressed_bytes(&core_config, &artifacts)
  } else {
    prepared_search_core_package_to_bytes(&core_config, &artifacts)
  };
  let bytes = package.map_err(|error| to_py_contract_error(&error))?;
  Ok(PyBytes::new(py, &bytes))
}

#[pyfunction]
fn redact_static_entities_diagnostics_json(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
) -> PyResult<String> {
  let prepared = PyPreparedSearch::new(config_json)?;
  prepared.redact_static_entities_diagnostics_json(full_text, operators_json)
}

#[pyfunction]
fn normalize_for_search(text: &str) -> String {
  stella_anonymize_core::normalize_for_search(text)
}

#[pyfunction]
#[allow(clippy::missing_const_for_fn)]
fn native_package_version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}

fn parse_prepared_search_config(
  config_json: &str,
) -> PyResult<BindingPreparedSearchConfig> {
  serde_json::from_str(config_json).map_err(|error| to_py_serde_error(&error))
}

fn parse_core_prepared_search_config(
  config_json: &str,
) -> PyResult<stella_anonymize_core::PreparedSearchConfig> {
  prepared_search_config_from_binding(parse_prepared_search_config(
    config_json,
  )?)
  .map_err(|error| to_py_contract_error(&error))
}

fn parse_operator_config(
  operators_json: Option<&str>,
) -> PyResult<Option<BindingOperatorConfig>> {
  operators_json
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_py_serde_error(&error))
}

fn static_redaction_result_to_python_binding(
  result: StaticRedactionResult,
  full_text: &str,
) -> std::result::Result<BindingStaticRedactionResult, ContractError> {
  let offsets = PythonOffsetMap::new(full_text)?;
  let mut result = static_redaction_result_to_binding(result);
  convert_pipeline_entity_offsets_to_python(
    &mut result.resolved_entities,
    &offsets,
  )?;
  Ok(result)
}

fn convert_pipeline_entity_offsets_to_python(
  entities: &mut [BindingPipelineEntity],
  offsets: &PythonOffsetMap,
) -> std::result::Result<(), ContractError> {
  for entity in entities {
    entity.start = offsets.convert(entity.start)?;
    entity.end = offsets.convert(entity.end)?;
  }
  Ok(())
}

struct PythonOffsetMap {
  boundaries: Vec<(u32, u32)>,
}

impl PythonOffsetMap {
  fn new(text: &str) -> std::result::Result<Self, ContractError> {
    let mut boundaries = Vec::new();
    let mut code_point_offset = 0_u32;
    boundaries.push((0, 0));

    for (byte_start, ch) in text.char_indices() {
      code_point_offset =
        code_point_offset.checked_add(1).ok_or_else(|| {
          ContractError::InvalidPreparedSearchPackage {
            reason: String::from("Python offset exceeds u32 range"),
          }
        })?;
      let byte_end = byte_start.saturating_add(ch.len_utf8());
      boundaries.push((u32_from_usize(byte_end)?, code_point_offset));
    }

    Ok(Self { boundaries })
  }

  fn convert(&self, offset: u32) -> std::result::Result<u32, ContractError> {
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
      .map(|(_, code_point_offset)| *code_point_offset)
  }
}

fn u32_from_usize(value: usize) -> std::result::Result<u32, ContractError> {
  u32::try_from(value).map_err(|_| {
    ContractError::InvalidPreparedSearchPackage {
      reason: format!("Offset exceeds u32 range: {value}"),
    }
  })
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
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
  module.add_class::<PyPreparedSearch>()?;
  module.add_class::<PyStaticRedactionResult>()?;
  module.add_class::<PyRedactionResult>()?;
  module.add_class::<PyRedactionEntry>()?;
  module.add_class::<PyOperatorEntry>()?;
  module.add_class::<PyPipelineEntity>()?;
  module
    .add_function(wrap_pyfunction!(redact_static_entities_json, module)?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_artifacts_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    prepare_static_search_compressed_package_bytes,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(
    redact_static_entities_diagnostics_json,
    module
  )?)?;
  module.add_function(wrap_pyfunction!(normalize_for_search, module)?)?;
  module.add_function(wrap_pyfunction!(native_package_version, module)?)?;
  Ok(())
}
