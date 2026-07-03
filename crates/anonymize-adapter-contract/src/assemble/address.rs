//! `address_context_data` and `address_seed_data`.
//!
//! `address_context_data` ports `getAddressContextData`
//! (`filters/confidence-boost.ts`); `address_seed_data` ports
//! `getAddressSeedData` (`detectors/address-seeds.ts`). Both are emitted only
//! when the "address" label is allowed.
//!
//! The two share the "flatten a language-keyed dictionary" shape but differ in
//! case handling, exactly mirroring the TypeScript: prepositions and street
//! abbreviations are lowercased before deduping, while bare-house stopwords and
//! address-seed words keep their original casing (deduped by a lowercase key).

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, parse_data_file, parse_ordered_data_file,
};

use super::AssembleContext;
use crate::{BindingAddressContextData, BindingAddressSeedData};

#[derive(Deserialize)]
struct AddressPrepositions {
  #[serde(default)]
  address: OrderedMap<Value>,
  #[serde(default)]
  temporal: OrderedMap<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddressContextJson {
  #[serde(default)]
  bare_house_stopwords: OrderedMap<Value>,
}

/// Mirrors `buildStreetTypePatterns` (`detectors/address-seeds.ts`): flatten
/// every array value of `address-street-types.json` in document order, no dedup
/// and no case change. Non-array values (the `_comment` string) are skipped.
///
/// # Errors
///
/// Returns [`AssembleError`] when `address-street-types.json` fails to parse.
pub(super) fn street_type_patterns() -> Result<Vec<String>, AssembleError> {
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let mut words = Vec::new();
  for (_key, value) in &street_types {
    let Some(items) = value.as_array() else {
      continue;
    };
    for word in items {
      if let Some(word) = word.as_str() {
        words.push(word.to_string());
      }
    }
  }
  Ok(words)
}

// ── address_context_data ────────────────────────────

/// # Errors
///
/// Returns [`AssembleError`] when any backing data file fails to parse.
pub(super) fn build_address_context_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingAddressContextData>, AssembleError> {
  if !ctx.label_allowed("address") {
    return Ok(None);
  }
  let prepositions: AddressPrepositions =
    parse_data_file("address-prepositions.json")?;
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;
  let context: AddressContextJson = parse_data_file("address-context.json")?;

  Ok(Some(BindingAddressContextData {
    address_prepositions: dedup_lowercased(&language_record_values(
      &prepositions.address,
    )),
    temporal_prepositions: dedup_lowercased(&language_record_values(
      &prepositions.temporal,
    )),
    street_abbreviations: build_street_abbreviations(&street_types),
    bare_house_stopwords: dedup_exact(&language_record_values(
      &context.bare_house_stopwords,
    )),
  }))
}

/// Mirrors `languageRecordValues` with the identity transform: concatenate the
/// array values of every non-`_` language key, in order, without deduping.
fn language_record_values(record: &OrderedMap<Value>) -> Vec<String> {
  let mut values = Vec::new();
  for (language, words) in record {
    if language.starts_with('_') {
      continue;
    }
    let Some(items) = words.as_array() else {
      continue;
    };
    for word in items {
      if let Some(word) = word.as_str() {
        values.push(word.to_string());
      }
    }
  }
  values
}

/// JS `[...new Set(values.map(w => w.toLowerCase()))]`.
fn dedup_lowercased(values: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for value in values {
    let lowered = value.to_lowercase();
    if seen.insert(lowered.clone()) {
      result.push(lowered);
    }
  }
  result
}

/// JS `[...new Set(values)]`: first-occurrence dedup, original casing.
fn dedup_exact(values: &[String]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for value in values {
    if seen.insert(value.clone()) {
      result.push(value.clone());
    }
  }
  result
}

/// Mirrors `buildStreetAbbrevs`: lowercased words that contain a dot, deduped
/// in first-occurrence order across all non-`_` language keys.
fn build_street_abbreviations(street_types: &OrderedMap<Value>) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut result = Vec::new();
  for (key, words) in street_types {
    if key.starts_with('_') {
      continue;
    }
    let Some(items) = words.as_array() else {
      continue;
    };
    for word in items {
      let Some(word) = word.as_str() else {
        continue;
      };
      if !word.contains('.') {
        continue;
      }
      let lowered = word.to_lowercase();
      if seen.insert(lowered.clone()) {
        result.push(lowered);
      }
    }
  }
  result
}

// ── address_seed_data ───────────────────────────────

/// # Errors
///
/// Returns [`AssembleError`] when any backing data file fails to parse.
pub(super) fn build_address_seed_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingAddressSeedData>, AssembleError> {
  if !ctx.label_allowed("address") {
    return Ok(None);
  }
  let boundaries: OrderedMap<Value> =
    parse_ordered_data_file("address-boundaries.json")?;
  let stop_keywords: OrderedMap<Value> =
    parse_ordered_data_file("address-stop-keywords.json")?;
  let unit_abbreviations: OrderedMap<Value> =
    parse_ordered_data_file("address-unit-abbreviations.json")?;
  let street_types: OrderedMap<Value> =
    parse_ordered_data_file("address-street-types.json")?;

  Ok(Some(BindingAddressSeedData {
    boundary_words: flatten_dictionaries(&[&boundaries, &stop_keywords]),
    br_cep_cue_words: build_br_cue_words(&street_types, &boundaries),
    unit_abbreviations: flatten_dictionaries(&[&unit_abbreviations]),
  }))
}

/// Mirrors `flattenDictionaries`/`flattenDictionary`: concatenate the array
/// values of each config (all keys, not just language keys), dropping empty
/// strings and deduping by a lowercase key in first-occurrence order.
fn flatten_dictionaries(configs: &[&OrderedMap<Value>]) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut words = Vec::new();
  for config in configs {
    for (_key, value) in *config {
      let Some(items) = value.as_array() else {
        continue;
      };
      for item in items {
        let Some(word) = item.as_str() else {
          continue;
        };
        if word.is_empty() {
          continue;
        }
        if seen.insert(word.to_lowercase()) {
          words.push(word.to_string());
        }
      }
    }
  }
  words
}

/// Mirrors `loadBrCueWords`: the `pt-br` arrays of `address-street-types` then
/// `address-boundaries`, deduped by lowercase in first-occurrence order.
fn build_br_cue_words(
  street_types: &OrderedMap<Value>,
  boundaries: &OrderedMap<Value>,
) -> Vec<String> {
  let mut seen = HashSet::new();
  let mut out = Vec::new();
  for source in [street_types, boundaries] {
    let Some((_, value)) = source.iter().find(|(key, _)| key == "pt-br") else {
      continue;
    };
    let Some(items) = value.as_array() else {
      continue;
    };
    for item in items {
      let Some(word) = item.as_str() else {
        continue;
      };
      if word.is_empty() {
        continue;
      }
      if seen.insert(word.to_lowercase()) {
        out.push(word.to_string());
      }
    }
  }
  out
}
