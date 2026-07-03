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
  compare_c2_data(name, actual, expected)?;
  compare_trigger_data(name, actual, expected)?;
  compare_regex_and_legal(name, actual, expected)?;
  Ok(())
}

/// Slice C2 data fields compared field-by-field.
fn compare_c2_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.gazetteer_data != expected.gazetteer_data {
    return Err(format!(
      "{name}: gazetteer_data {:?} != {:?}",
      actual.gazetteer_data, expected.gazetteer_data
    ));
  }
  if actual.coreference_data != expected.coreference_data {
    return Err(format!(
      "{name}: coreference_data {:?} != {:?}",
      actual.coreference_data, expected.coreference_data
    ));
  }
  Ok(())
}

/// Compares `trigger_data` with a targeted first-difference report (the rule
/// array has ~1400 entries, so a full `{:?}` dump is unreadable).
fn compare_trigger_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.trigger_data, &expected.trigger_data) {
    (None, None) => return Ok(()),
    (Some(got), Some(want)) => {
      if got.rules.len() != want.rules.len() {
        return Err(format!(
          "{name}: trigger_data.rules length {} != {}",
          got.rules.len(),
          want.rules.len()
        ));
      }
      for (index, (g, w)) in got.rules.iter().zip(want.rules.iter()).enumerate()
      {
        if g != w {
          return Err(format!(
            "{name}: trigger_data.rules[{index}] differs\n  got:  {g:?}\n  want: {w:?}"
          ));
        }
      }
      if got != want {
        return Err(format!(
          "{name}: trigger_data support members differ\n  got:  {:?}\n  want: {:?}",
          TriggerSupport::from(got),
          TriggerSupport::from(want)
        ));
      }
    }
    (got, want) => {
      return Err(format!(
        "{name}: trigger_data presence differs (got {}, want {})",
        got.is_some(),
        want.is_some()
      ));
    }
  }
  Ok(())
}

/// Support-member view of `trigger_data` (rules elided) for readable diffs.
#[derive(Debug)]
#[allow(dead_code)]
struct TriggerSupport<'a> {
  address_stop_keywords: &'a [String],
  party_position_terms: &'a [String],
  post_nominals: &'a [String],
  sentence_terminal_currency_terms: &'a [String],
  phone_extension_labels: &'a [String],
  number_markers: &'a [String],
  number_labels: &'a [String],
}

impl<'a> From<&'a stella_anonymize_adapter_contract::BindingTriggerData>
  for TriggerSupport<'a>
{
  fn from(
    data: &'a stella_anonymize_adapter_contract::BindingTriggerData,
  ) -> Self {
    Self {
      address_stop_keywords: &data.address_stop_keywords,
      party_position_terms: &data.party_position_terms,
      post_nominals: &data.post_nominals,
      sentence_terminal_currency_terms: &data.sentence_terminal_currency_terms,
      phone_extension_labels: &data.phone_extension_labels,
      number_markers: &data.number_markers,
      number_labels: &data.number_labels,
    }
  }
}

/// `regex_meta` (full), `legal_form_data` (full), and the full `regex_patterns`
/// array (static + signing prefix, then legal-form and trigger literal tails).
fn compare_regex_and_legal(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_meta != expected.regex_meta {
    return Err(format!(
      "{name}: regex_meta {:?} != {:?}",
      actual.regex_meta, expected.regex_meta
    ));
  }
  if actual.legal_form_data != expected.legal_form_data {
    return Err(format!(
      "{name}: legal_form_data {:?} != {:?}",
      actual.legal_form_data, expected.legal_form_data
    ));
  }
  compare_regex_patterns(name, actual, expected)
}

/// FULL check for `regex_patterns` with a targeted first-difference report.
fn compare_regex_patterns(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_patterns.len() != expected.regex_patterns.len() {
    return Err(format!(
      "{name}: regex_patterns length {} != {}",
      actual.regex_patterns.len(),
      expected.regex_patterns.len()
    ));
  }
  for (index, (got, want)) in actual
    .regex_patterns
    .iter()
    .zip(expected.regex_patterns.iter())
    .enumerate()
  {
    if got != want {
      return Err(format!(
        "{name}: regex_patterns[{index}] differs\n  got:  {got:?}\n  want: {want:?}"
      ));
    }
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
