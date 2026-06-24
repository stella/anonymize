#![allow(clippy::print_stdout)]

use std::env;
use std::io::Write;
use std::time::Instant;

use serde::Deserialize;
use serde_json::json;
use stella_anonymize_adapter_contract::{
  BindingOperatorConfig, BindingPreparedSearchConfig,
  operator_config_from_binding, prepared_search_config_from_binding,
};
use stella_anonymize_core::PreparedSearch;

#[derive(Deserialize)]
struct Payload {
  config_json: String,
  iterations: usize,
  cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
  text: String,
  operators_json: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let payload = env::var("STELLA_ANONYMIZE_PERF_PAYLOAD")?;
  let payload = serde_json::from_str::<Payload>(&payload)?;
  let config =
    serde_json::from_str::<BindingPreparedSearchConfig>(&payload.config_json)?;

  let prepare_start = Instant::now();
  let prepared =
    PreparedSearch::new(prepared_search_config_from_binding(config)?)?;
  let prepare_ms = elapsed_ms(prepare_start);

  let run_start = Instant::now();
  let mut entity_count = 0_usize;
  for _ in 0..payload.iterations {
    for item in &payload.cases {
      let operators = item
        .operators_json
        .as_deref()
        .map(serde_json::from_str::<BindingOperatorConfig>)
        .transpose()?;
      let operators = operator_config_from_binding(operators)?;
      let result = prepared.redact_static_entities(&item.text, &operators)?;
      entity_count = entity_count.saturating_add(result.redaction.entity_count);
    }
  }
  let run_ms = elapsed_ms(run_start);

  let mut stdout = std::io::stdout().lock();
  writeln!(
    stdout,
    "{}",
    json!({
      "prepareMs": prepare_ms,
      "runMs": run_ms,
      "entityCount": entity_count,
    })
  )?;
  Ok(())
}

fn elapsed_ms(start: Instant) -> f64 {
  start.elapsed().as_secs_f64() * 1_000.0
}
