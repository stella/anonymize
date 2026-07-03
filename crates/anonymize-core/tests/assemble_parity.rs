//! Golden parity: the Rust assembler must reproduce the TypeScript
//! `buildNativeStaticSearchBundle` output for the fields slice A implements.
//!
//! Fixtures are captured by
//! `packages/anonymize/scripts/capture-assemble-fixtures.mjs`. Each
//! `<name>.input.json` holds the `{ config, gazetteer }` inputs; each
//! `<name>.expected.json` holds the implemented fields of the native static
//! config in stable key order. This test compares ONLY those fields; later
//! slices tick fields off `FIELDS_PENDING` and add them here.
//!
//! `name_corpus_mode` is intentionally not compared: the TypeScript source only
//! emits it when name-corpus data is present, which this slice does not yet
//! assemble.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};

#[derive(Deserialize)]
struct FixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

fn fixtures_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble")
}

fn collect_input_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
  let mut paths = Vec::new();
  let entries =
    fs::read_dir(dir).map_err(|error| format!("read_dir failed: {error}"))?;
  for entry in entries {
    let path = entry.map_err(|error| format!("dir entry: {error}"))?.path();
    let is_input = path
      .file_name()
      .and_then(|name| name.to_str())
      .is_some_and(|name| name.ends_with(".input.json"));
    if is_input {
      paths.push(path);
    }
  }
  paths.sort();
  Ok(paths)
}

fn expected_path_for(input_path: &Path) -> Result<PathBuf, String> {
  let file_name = input_path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| "non-utf8 fixture name".to_string())?;
  let base = file_name
    .strip_suffix(".input.json")
    .ok_or_else(|| format!("unexpected fixture name {file_name}"))?;
  Ok(input_path.with_file_name(format!("{base}.expected.json")))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

/// Compares only the fields slice A assembles. Returns a description of the
/// first mismatch, if any.
fn compare_implemented(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.allowed_labels != expected.allowed_labels {
    return Err(format!(
      "{name}: allowed_labels {:?} != {:?}",
      actual.allowed_labels, expected.allowed_labels
    ));
  }
  if actual.threshold.to_bits() != expected.threshold.to_bits() {
    return Err(format!(
      "{name}: threshold {} != {}",
      actual.threshold, expected.threshold
    ));
  }
  if actual.confidence_boost != expected.confidence_boost {
    return Err(format!(
      "{name}: confidence_boost {} != {}",
      actual.confidence_boost, expected.confidence_boost
    ));
  }
  if actual.custom_regex_patterns != expected.custom_regex_patterns {
    return Err(format!(
      "{name}: custom_regex_patterns {:?} != {:?}",
      actual.custom_regex_patterns, expected.custom_regex_patterns
    ));
  }
  if actual.regex_options != expected.regex_options {
    return Err(format!(
      "{name}: regex_options {:?} != {:?}",
      actual.regex_options, expected.regex_options
    ));
  }
  if actual.custom_regex_options != expected.custom_regex_options {
    return Err(format!(
      "{name}: custom_regex_options {:?} != {:?}",
      actual.custom_regex_options, expected.custom_regex_options
    ));
  }
  if actual.signature_data != expected.signature_data {
    return Err(format!(
      "{name}: signature_data {:?} != {:?}",
      actual.signature_data, expected.signature_data
    ));
  }
  if actual.monetary_data != expected.monetary_data {
    return Err(format!(
      "{name}: monetary_data {:?} != {:?}",
      actual.monetary_data, expected.monetary_data
    ));
  }
  if actual.date_data != expected.date_data {
    return Err(format!(
      "{name}: date_data {:?} != {:?}",
      actual.date_data, expected.date_data
    ));
  }
  if actual.zone_data != expected.zone_data {
    return Err(format!(
      "{name}: zone_data {:?} != {:?}",
      actual.zone_data, expected.zone_data
    ));
  }
  if actual.address_context_data != expected.address_context_data {
    return Err(format!(
      "{name}: address_context_data {:?} != {:?}",
      actual.address_context_data, expected.address_context_data
    ));
  }
  if actual.address_seed_data != expected.address_seed_data {
    return Err(format!(
      "{name}: address_seed_data {:?} != {:?}",
      actual.address_seed_data, expected.address_seed_data
    ));
  }
  if actual.country_data != expected.country_data {
    return Err(format!(
      "{name}: country_data {:?} != {:?}",
      actual.country_data, expected.country_data
    ));
  }
  if actual.hotword_data != expected.hotword_data {
    return Err(format!(
      "{name}: hotword_data {:?} != {:?}",
      actual.hotword_data, expected.hotword_data
    ));
  }
  if actual.custom_regex_meta != expected.custom_regex_meta {
    return Err(format!(
      "{name}: custom_regex_meta {:?} != {:?}",
      actual.custom_regex_meta, expected.custom_regex_meta
    ));
  }
  Ok(())
}

fn check_fixture(input_path: &Path) -> Result<(), String> {
  let name = input_path
    .file_name()
    .and_then(|file_name| file_name.to_str())
    .and_then(|file_name| file_name.strip_suffix(".input.json"))
    .unwrap_or("<unknown>");
  let input: FixtureInput = read_json(input_path)?;
  let expected: BindingPreparedSearchConfig =
    read_json(&expected_path_for(input_path)?)?;
  let actual = assemble_static_search_config(
    &input.config,
    input.config.dictionaries.as_ref(),
    &input.gazetteer,
  )
  .map_err(|error| format!("{name}: assemble failed: {error}"))?;
  compare_implemented(name, &actual, &expected)
}

#[test]
fn assemble_parity_matches_typescript() -> Result<(), String> {
  let dir = fixtures_dir();
  let inputs = collect_input_paths(&dir)?;
  if inputs.len() < 30 {
    return Err(format!(
      "expected the captured fixture set, found {} inputs in {}",
      inputs.len(),
      dir.display()
    ));
  }

  let mut failures = Vec::new();
  for input_path in &inputs {
    if let Err(error) = check_fixture(input_path) {
      failures.push(error);
    }
  }
  if failures.is_empty() {
    return Ok(());
  }
  Err(format!(
    "assemble parity mismatches ({} of {}):\n{}",
    failures.len(),
    inputs.len(),
    failures.join("\n")
  ))
}
