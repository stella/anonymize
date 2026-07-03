//! End-to-end digest gate: the Rust assembler, fed through the same
//! prepare/package path the native binding uses, must reproduce the SHA-256
//! package digest the TypeScript source captured in `manifest.json`.
//!
//! For each fixture the test assembles a [`BindingPreparedSearchConfig`] from
//! the committed inputs, converts it to a core `PreparedEngineConfig`, prepares
//! the artifacts, serializes the uncompressed core package, and hashes the
//! bytes. The `manifest.json` digests were produced by
//! `capture-assemble-fixtures.mjs` via `prepareStaticSearchPackageBytes`
//! (`node:crypto` SHA-256, since blake3 is not exposed to JS), so a digest match
//! proves the assembled config is byte-identical end to end, not just field-wise.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
  prepared_search_config_from_binding, prepared_search_core_package_to_bytes,
};
use stella_anonymize_core::PreparedEngine;
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};

#[derive(Deserialize)]
struct FixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

#[derive(Deserialize)]
struct Manifest {
  fixtures: Vec<ManifestFixture>,
}

#[derive(Deserialize)]
struct ManifestFixture {
  name: String,
  #[serde(rename = "packageDigest")]
  package_digest: Option<String>,
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

/// Assembles the config and returns the SHA-256 hex digest of the uncompressed
/// core package bytes.
fn package_digest(input: &FixtureInput) -> Result<String, String> {
  let binding: BindingPreparedSearchConfig = assemble_static_search_config(
    &input.config,
    input.config.dictionaries.as_ref(),
    &input.gazetteer,
  )
  .map_err(|error| format!("assemble failed: {error}"))?;

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
  hasher.update(&package);
  let digest = hasher.finalize();
  let mut hex = String::new();
  for byte in digest {
    let _ = write!(hex, "{byte:02x}");
  }
  Ok(hex)
}

#[test]
fn assemble_package_digests_match_manifest() -> Result<(), String> {
  let dir = fixtures_dir();
  let manifest: Manifest = read_json(&dir.join("manifest.json"))?;

  let mut failures = Vec::new();
  let mut checked = 0usize;
  for fixture in &manifest.fixtures {
    let Some(expected) = fixture.package_digest.as_ref() else {
      failures.push(format!("{}: manifest digest is null", fixture.name));
      continue;
    };
    let input: FixtureInput =
      match read_json(&dir.join(format!("{}.input.json", fixture.name))) {
        Ok(input) => input,
        Err(error) => {
          failures.push(format!("{}: {error}", fixture.name));
          continue;
        }
      };
    match package_digest(&input) {
      Ok(actual) if &actual == expected => checked += 1,
      Ok(actual) => failures
        .push(format!("{}: digest {actual} != {expected}", fixture.name)),
      Err(error) => failures.push(format!("{}: {error}", fixture.name)),
    }
  }

  if !failures.is_empty() {
    return Err(format!(
      "digest gate mismatches ({} of {}):\n{}",
      failures.len(),
      manifest.fixtures.len(),
      failures.join("\n")
    ));
  }
  assert_eq!(
    checked,
    manifest.fixtures.len(),
    "expected every fixture digest to be checked"
  );
  Ok(())
}
