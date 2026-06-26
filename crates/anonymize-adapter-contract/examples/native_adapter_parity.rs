#![allow(clippy::print_stdout)]

use std::{env, fs, io::Write};

use serde::Deserialize;
use stella_anonymize_adapter_contract::{
  BindingOperatorConfig, BindingPreparedSearchConfig,
  BindingStaticRedactionResult, operator_config_from_binding,
  prepared_search_config_from_binding,
  static_redaction_result_to_utf16_binding,
};
use stella_anonymize_core::PreparedSearch;

#[derive(Deserialize)]
struct Payload {
  config_json: String,
  cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
  text: String,
  operators_json: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let payload_path = env::var("STELLA_ANONYMIZE_PARITY_PAYLOAD")?;
  let payload = fs::read_to_string(payload_path)?;
  let payload = serde_json::from_str::<Payload>(&payload)?;
  let config =
    serde_json::from_str::<BindingPreparedSearchConfig>(&payload.config_json)?;
  let prepared =
    PreparedSearch::new(prepared_search_config_from_binding(config)?)?;
  let results = payload
    .cases
    .iter()
    .map(|case| run_case(&prepared, case))
    .collect::<Result<Vec<_>, _>>()?;

  let mut stdout = std::io::stdout().lock();
  writeln!(stdout, "{}", serde_json::to_string(&results)?)?;
  Ok(())
}

fn run_case(
  prepared: &PreparedSearch,
  case: &Case,
) -> Result<BindingStaticRedactionResult, Box<dyn std::error::Error>> {
  let operators = case
    .operators_json
    .as_deref()
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()?;
  let operators = operator_config_from_binding(operators)?;
  let result = prepared.redact_static_entities(&case.text, &operators)?;
  Ok(static_redaction_result_to_utf16_binding(
    result, &case.text,
  )?)
}
