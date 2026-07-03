//! Serde input struct for pre-loaded dictionary data.
//!
//! Mirrors `Dictionaries` in `types.ts`. Maps use `OrderedMap` to preserve
//! iteration; later assembly slices that depend on TypeScript object insertion
//! order (positional prepare) may need an order-preserving map instead.

use crate::assemble::data::OrderedMap;

use serde::{Deserialize, Serialize};

use super::config::DictionaryMeta;

/// Pre-loaded dictionary data for dependency injection.
///
/// Every field is optional; an absent field means the corresponding detection
/// path is skipped.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictionaries {
  /// First names per language code.
  pub first_names: Option<OrderedMap<Vec<String>>>,
  /// Surnames per language code.
  pub surnames: Option<OrderedMap<Vec<String>>>,
  /// Non-Western name tokens per locale code.
  pub non_western_names: Option<OrderedMap<Vec<String>>>,
  /// Deny-list dictionaries keyed by dictionary ID.
  pub deny_list: Option<OrderedMap<Vec<String>>>,
  /// Metadata per dictionary ID.
  pub deny_list_meta: Option<OrderedMap<DictionaryMeta>>,
  /// City names already merged across countries.
  pub cities: Option<Vec<String>>,
  /// City names keyed by ISO 3166-1 alpha-2 country code.
  pub cities_by_country: Option<OrderedMap<Vec<String>>>,
}
