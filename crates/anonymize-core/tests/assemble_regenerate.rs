//! Explicit updater for assemble parity fixtures.
//!
//! This is an ignored test, and it additionally requires both an opt-in write
//! gate and an explicit fixture allowlist. Normal test and CI runs are read-only.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
  prepared_search_config_from_binding, prepared_search_core_package_to_bytes,
};
use stella_anonymize_core::PreparedEngine;
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};

const UPDATE_ENV: &str = "STELLA_UPDATE_ASSEMBLE_FIXTURES";
const FIXTURES_ENV: &str = "STELLA_ASSEMBLE_FIXTURES";

#[derive(Deserialize)]
struct FixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
  generated_by: String,
  source: String,
  digest: ManifestDigest,
  fixtures: Vec<ManifestFixture>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestDigest {
  algorithm: String,
  hashed_input: String,
  note: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFixture {
  name: String,
  package_digest: Option<String>,
  has_dictionaries: bool,
  gazetteer_count: usize,
}

fn fixtures_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn selected_fixture_names() -> Result<BTreeSet<String>, String> {
  if env::var(UPDATE_ENV).as_deref() != Ok("1") {
    return Err(format!(
      "refusing to write: set {UPDATE_ENV}=1 and {FIXTURES_ENV} to an explicit comma-separated allowlist"
    ));
  }

  let value = env::var(FIXTURES_ENV).map_err(|_| {
    format!("{FIXTURES_ENV} must contain an explicit allowlist")
  })?;
  let names: BTreeSet<_> = value
    .split(',')
    .map(str::trim)
    .filter(|name| !name.is_empty())
    .map(ToOwned::to_owned)
    .collect();
  if names.is_empty() {
    return Err(format!("{FIXTURES_ENV} allowlist must not be empty"));
  }
  Ok(names)
}

fn normalized_value(value: &Value) -> Value {
  match value {
    Value::Object(object) => Value::Object(
      object
        .iter()
        .filter(|(_, item)| !item.is_null())
        .map(|(key, item)| (key.clone(), normalized_value(item)))
        .collect::<Map<_, _>>(),
    ),
    Value::Array(values) => {
      Value::Array(values.iter().map(normalized_value).collect())
    }
    _ => value.clone(),
  }
}

fn equivalent(left: &Value, right: &Value) -> bool {
  match (left, right) {
    (Value::Number(left), Value::Number(right)) => {
      left.as_f64() == right.as_f64()
    }
    _ => left == right,
  }
}

fn compatible_shape(expected: &Value, actual: &Value) -> bool {
  match (expected, actual) {
    (Value::Object(expected), Value::Object(actual)) => {
      expected.iter().all(|(key, expected_value)| {
        actual.get(key).is_some_and(|actual_value| {
          compatible_shape(expected_value, actual_value)
        })
      })
    }
    (Value::Array(expected), Value::Array(actual)) => {
      expected.len() == actual.len()
        && expected
          .iter()
          .zip(actual)
          .all(|(expected, actual)| compatible_shape(expected, actual))
    }
    _ => equivalent(expected, actual),
  }
}

fn shaped_value(actual: &Value, template: &Value) -> Value {
  match (actual, template) {
    (Value::Object(actual), Value::Object(template)) => Value::Object(
      template
        .iter()
        .filter_map(|(key, template_value)| {
          actual.get(key).map(|actual_value| {
            (key.clone(), shaped_value(actual_value, template_value))
          })
        })
        .collect::<Map<_, _>>(),
    ),
    (Value::Array(actual), Value::Array(template)) => {
      let values = actual
        .iter()
        .map(|actual_value| {
          template
            .iter()
            .find(|candidate| compatible_shape(candidate, actual_value))
            .or_else(|| template.first())
            .map_or_else(
              || normalized_value(actual_value),
              |candidate| shaped_value(actual_value, candidate),
            )
        })
        .collect();
      Value::Array(values)
    }
    _ => normalized_value(actual),
  }
}

fn closest_template<'a>(
  actual: &Value,
  templates: &'a [Value],
) -> Option<&'a Value> {
  templates.iter().find(|template| {
    let (Value::Object(template), Value::Object(actual)) = (template, actual)
    else {
      return compatible_shape(template, actual);
    };
    ["kind", "type", "label"]
      .iter()
      .filter_map(|key| template.get(*key).zip(actual.get(*key)))
      .all(|(template, actual)| equivalent(template, actual))
  })
}

/// Merge current Rust output into the established oracle shape. Unchanged
/// values retain their committed ordering and omission style; changed arrays
/// can grow or shrink without rewriting unrelated fixture data.
fn merge_current(expected: &mut Value, actual: &Value) {
  if equivalent(expected, actual) {
    return;
  }
  match (expected, actual) {
    (Value::Object(expected), Value::Object(actual)) => {
      expected.retain(|key, _| actual.contains_key(key));
      for (key, actual_value) in actual {
        if let Some(expected_value) = expected.get_mut(key) {
          merge_current(expected_value, actual_value);
        }
      }
    }
    (Value::Array(expected), Value::Array(actual)) => {
      let prefix = expected
        .iter()
        .zip(actual.iter())
        .take_while(|(expected, actual)| compatible_shape(expected, actual))
        .count();
      let suffix = expected
        .iter()
        .skip(prefix)
        .rev()
        .zip(actual.iter().skip(prefix).rev())
        .take_while(|(expected_item, actual_item)| {
          compatible_shape(expected_item, actual_item)
        })
        .count();
      let actual_middle_end = actual.len().saturating_sub(suffix);
      let expected_middle_end = expected.len().saturating_sub(suffix);
      let templates = expected.clone();
      let replacement = actual
        .iter()
        .skip(prefix)
        .take(actual_middle_end.saturating_sub(prefix))
        .map(|actual_value| {
          closest_template(actual_value, &templates).map_or_else(
            || normalized_value(actual_value),
            |template| shaped_value(actual_value, template),
          )
        })
        .collect::<Vec<_>>();
      expected.splice(prefix..expected_middle_end, replacement);
      for (expected_item, actual_item) in expected
        .iter_mut()
        .take(prefix)
        .zip(actual.iter().take(prefix))
      {
        merge_current(expected_item, actual_item);
      }
      if suffix > 0 {
        let expected_start = expected.len().saturating_sub(suffix);
        let actual_start = actual.len().saturating_sub(suffix);
        for (expected_item, actual_item) in expected
          .iter_mut()
          .skip(expected_start)
          .zip(actual.iter().skip(actual_start))
        {
          merge_current(expected_item, actual_item);
        }
      }
    }
    (expected, actual) => *expected = normalized_value(actual),
  }
}

fn assemble_fixture(
  input: &FixtureInput,
  expected: &mut Value,
) -> Result<(String, String), String> {
  let binding: BindingPreparedSearchConfig = assemble_static_search_config(
    &input.config,
    input.config.dictionaries.as_ref(),
    &input.gazetteer,
  )
  .map_err(|error| format!("assemble failed: {error}"))?;

  let actual = serde_json::to_value(&binding)
    .map_err(|error| format!("serialize current config: {error}"))?;
  merge_current(expected, &actual);
  let expected = serde_json::to_string_pretty(expected)
    .map_err(|error| format!("serialize expected config: {error}"))?
    + "\n";
  let core_config = prepared_search_config_from_binding(binding)
    .map_err(|error| format!("config_from_binding failed: {error}"))?;
  let artifacts = PreparedEngine::prepare_artifacts(core_config.clone())
    .map_err(|error| format!("prepare_artifacts failed: {error}"))?;
  let artifact_bytes = artifacts
    .to_bytes()
    .map_err(|error| format!("artifacts.to_bytes failed: {error}"))?;
  let package =
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
      .map_err(|error| format!("package_to_bytes failed: {error}"))?;

  let mut hasher = Sha256::new();
  hasher.update(package);
  let mut digest = String::new();
  for byte in hasher.finalize() {
    write!(digest, "{byte:02x}")
      .map_err(|error| format!("format package digest: {error}"))?;
  }
  Ok((expected, digest))
}

#[test]
#[ignore = "writes frozen fixtures; requires an explicit write gate and allowlist"]
fn regenerate_selected_assemble_fixtures() -> Result<(), String> {
  let selected = selected_fixture_names()?;
  let dir = fixtures_dir();
  let manifest_path = dir.join("manifest.json");
  let mut manifest: Manifest = read_json(&manifest_path)?;
  let known: BTreeSet<_> = manifest
    .fixtures
    .iter()
    .map(|fixture| fixture.name.clone())
    .collect();
  let unknown: Vec<_> = selected.difference(&known).cloned().collect();
  if !unknown.is_empty() {
    return Err(format!("unknown assemble fixtures: {}", unknown.join(", ")));
  }

  let mut outputs = BTreeMap::new();
  let mut digests = BTreeMap::new();
  for name in &selected {
    let input: FixtureInput =
      read_json(&dir.join(format!("{name}.input.json")))?;
    let expected_path = dir.join(format!("{name}.expected.json"));
    let mut previous: Value = read_json(&expected_path)?;
    let (expected, digest) = assemble_fixture(&input, &mut previous)?;
    outputs.insert(expected_path, expected);
    digests.insert(name, digest);
  }

  for fixture in &mut manifest.fixtures {
    if let Some(digest) = digests.get(&fixture.name) {
      fixture.package_digest = Some(digest.clone());
    }
  }
  let manifest_json = serde_json::to_string_pretty(&manifest)
    .map_err(|error| format!("serialize manifest: {error}"))?
    + "\n";

  let mut formatted_paths = Vec::with_capacity(outputs.len() + 1);
  for (path, contents) in outputs {
    fs::write(&path, contents)
      .map_err(|error| format!("write {}: {error}", path.display()))?;
    formatted_paths.push(path);
  }
  fs::write(&manifest_path, manifest_json)
    .map_err(|error| format!("write {}: {error}", manifest_path.display()))?;
  formatted_paths.push(manifest_path);

  let status = Command::new("bun")
    .args(["x", "oxfmt"])
    .args(&formatted_paths)
    .status()
    .map_err(|error| format!("run repository JSON formatter: {error}"))?;
  if !status.success() {
    return Err(format!("repository JSON formatter exited with {status}"));
  }

  Ok(())
}
