//! Embedded canonical data config tree.
//!
//! The `DATA_FILES` table is generated at build time by `build.rs` from
//! `packages/data/config/*.json`. Parsing is on demand (no module-level side
//! effects): callers request a file by name and deserialize it into a typed
//! shape only when a slice needs it.

use serde::de::DeserializeOwned;

use super::error::AssembleError;

include!(concat!(env!("OUT_DIR"), "/assemble_data_generated.rs"));

/// All embedded data file names, sorted, as generated from the config tree.
#[must_use]
pub fn data_file_names() -> Vec<&'static str> {
  DATA_FILES.iter().map(|(name, _)| *name).collect()
}

/// Number of embedded data files.
#[must_use]
pub fn data_file_count() -> usize {
  DATA_FILES.len()
}

/// Returns the raw contents of an embedded data file by name, if present.
#[must_use]
pub fn data_file(name: &str) -> Option<&'static str> {
  DATA_FILES
    .iter()
    .find(|(file_name, _)| *file_name == name)
    .map(|(_, contents)| *contents)
}

/// Parses an embedded data file into a typed shape on demand.
///
/// # Errors
///
/// Returns [`AssembleError::MissingDataFile`] when the name is not embedded and
/// [`AssembleError::DataParse`] when the contents do not match `T`.
pub fn parse_data_file<T: DeserializeOwned>(
  name: &str,
) -> Result<T, AssembleError> {
  let contents =
    data_file(name).ok_or_else(|| AssembleError::MissingDataFile {
      name: name.to_string(),
    })?;
  serde_json::from_str(contents).map_err(|error| AssembleError::DataParse {
    name: name.to_string(),
    message: error.to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn embeds_the_full_config_tree() {
    // Guards against a build.rs regression that silently drops files.
    assert!(
      data_file_count() >= 80,
      "expected the full config tree, found {} files",
      data_file_count()
    );
  }

  #[test]
  fn every_embedded_file_is_valid_json() {
    // Load-time validation: every embedded artifact must parse as JSON.
    for name in data_file_names() {
      let value = parse_data_file::<serde_json::Value>(name);
      assert!(value.is_ok(), "embedded data file {name} is not valid JSON");
    }
  }

  #[test]
  fn known_file_is_reachable() {
    assert!(
      data_file("countries.json").is_some(),
      "countries.json should be embedded"
    );
    assert!(data_file("does-not-exist.json").is_none());
  }
}
