//! Embedded canonical data config tree.
//!
//! The `DATA_FILES` table is generated at build time by `build.rs` from
//! `packages/data/config/*.json`. Parsing is on demand (no module-level side
//! effects): callers request a file by name and deserialize it into a typed
//! shape only when a slice needs it.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{DeserializeOwned, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

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
  // DATA_FILES is emitted sorted by name (build.rs), so binary search holds.
  DATA_FILES
    .binary_search_by_key(&name, |(file_name, _)| file_name)
    .ok()
    .and_then(|index| DATA_FILES.get(index).map(|(_, contents)| *contents))
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

/// A JSON object deserialized while preserving its document key order.
///
/// `serde_json`'s `Value`/`Map` sort keys into a `BTreeMap` unless the
/// `preserve_order` feature is on, which would rewrite the semantics globally.
/// The assembler ports TypeScript logic that iterates `Object.entries(...)` in
/// insertion order (dictionary flatten/dedup, month tables), so key order is
/// load-bearing. Streaming deserialization through `MapAccess` yields entries
/// in document order regardless of that feature, so this newtype captures the
/// JS `Object.entries` order without touching the rest of the crate.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OrderedMap<T>(pub Vec<(String, T)>);

impl<T> OrderedMap<T> {
  /// Linear-scan lookup by key. The dictionary maps this backs are small
  /// (dozens of language/file keys), so O(n) is fine and keeps insertion
  /// order the single source of truth.
  #[must_use]
  pub fn get(&self, key: &str) -> Option<&T> {
    self
      .0
      .iter()
      .find(|(entry_key, _)| entry_key == key)
      .map(|(_, value)| value)
  }

  /// Iterates values in insertion order.
  pub fn values(&self) -> impl Iterator<Item = &T> {
    self.0.iter().map(|(_, value)| value)
  }

  /// Iterates the `(key, value)` pairs in document order.
  pub fn iter(&self) -> std::slice::Iter<'_, (String, T)> {
    self.0.iter()
  }
}

impl<'a, T> IntoIterator for &'a OrderedMap<T> {
  type Item = &'a (String, T);
  type IntoIter = std::slice::Iter<'a, (String, T)>;

  fn into_iter(self) -> Self::IntoIter {
    self.0.iter()
  }
}

impl<T: serde::Serialize> serde::Serialize for OrderedMap<T> {
  fn serialize<S: serde::Serializer>(
    &self,
    serializer: S,
  ) -> Result<S::Ok, S::Error> {
    serializer.collect_map(self.0.iter().map(|(key, value)| (key, value)))
  }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedMap<T> {
  fn deserialize<D: Deserializer<'de>>(
    deserializer: D,
  ) -> Result<Self, D::Error> {
    struct OrderedVisitor<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> Visitor<'de> for OrderedVisitor<T> {
      type Value = Vec<(String, T)>;

      fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object")
      }

      fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
      ) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, T>()? {
          entries.push((key, value));
        }
        Ok(entries)
      }
    }

    deserializer
      .deserialize_map(OrderedVisitor(PhantomData))
      .map(OrderedMap)
  }
}

/// Parses an embedded data file into an order-preserving object on demand.
///
/// # Errors
///
/// Returns [`AssembleError::MissingDataFile`] when the name is not embedded and
/// [`AssembleError::DataParse`] when the contents do not match `OrderedMap<T>`.
pub fn parse_ordered_data_file<T: DeserializeOwned>(
  name: &str,
) -> Result<OrderedMap<T>, AssembleError> {
  parse_data_file(name)
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
