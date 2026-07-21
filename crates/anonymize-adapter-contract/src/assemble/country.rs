//! `country_data` + ordered country surface forms.
//!
//! Ports `buildCountryPatterns` (`detectors/countries.ts`). The binding
//! `country_data` carries parallel label, ISO-code, and variant metadata for
//! every ordered surface form. alpha-2/alpha-3 codes stay disabled
//! (`INCLUDE_ALPHA2` / `INCLUDE_ALPHA3` are `false`). Emitted when countries
//! are not explicitly disabled and the "country" label is allowed.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, parse_data_file,
};
use stella_anonymize_core::normalize_for_search;

use super::AssembleContext;
use crate::{BindingCountryMatchData, BindingCountryVariant};

const ENTITY_LABEL: &str = "country";
const CURLY_APOSTROPHES: [char; 2] = ['\u{2018}', '\u{2019}'];

#[derive(Deserialize)]
struct AmbiguousSurfaces {
  #[serde(default)]
  words: Vec<String>,
}

/// Inner objects must stay in document order (`serde_json` `Value::Object`
/// sorts keys without the `preserve_order` feature), so nest `OrderedMap`.
#[derive(Deserialize)]
struct RawCountryData {
  #[serde(default)]
  names: OrderedMap<OrderedMap<Value>>,
  #[serde(default)]
  aliases: OrderedMap<Value>,
}

struct CountrySurface {
  display: String,
  iso_code: String,
  variant: BindingCountryVariant,
}

/// Mirrors `buildCountryPatterns`: the ordered list of registered surface forms
/// (the `display` values of `surfaceToMeta`, in insertion order). `None` when
/// the country detector is disabled or its label is filtered out.
///
/// # Errors
///
/// Returns [`AssembleError`] when `countries.json` or
/// `ambiguous-country-surfaces.json` fails to parse.
pub(super) fn country_surface_forms(
  ctx: &AssembleContext<'_>,
) -> Result<Option<Vec<String>>, AssembleError> {
  Ok(country_surfaces(ctx)?.map(|surfaces| {
    surfaces
      .into_iter()
      .map(|surface| surface.display)
      .collect()
  }))
}

fn country_surfaces(
  ctx: &AssembleContext<'_>,
) -> Result<Option<Vec<CountrySurface>>, AssembleError> {
  if ctx.config.enable_countries == Some(false) || !ctx.label_allowed("country")
  {
    return Ok(None);
  }

  let ambiguous: AmbiguousSurfaces =
    parse_data_file("ambiguous-country-surfaces.json")?;
  let blocklist: HashSet<String> = ambiguous
    .words
    .iter()
    .map(|word| word.to_lowercase())
    .collect();

  let raw: RawCountryData = parse_data_file("countries.json")?;

  // Insertion-ordered surface set: first writer wins per lowercased key.
  let mut surfaces: Vec<CountrySurface> = Vec::new();
  let mut seen: HashSet<String> = HashSet::new();
  let mut register =
    |surface: &str, iso_code: &str, variant: BindingCountryVariant| {
      let trimmed = surface.trim();
      if trimmed.is_empty() {
        return;
      }
      let normalized = normalize_for_search(trimmed);
      let key = normalized.to_lowercase();
      if blocklist.contains(&key) {
        return;
      }
      if seen.insert(key) {
        surfaces.push(CountrySurface {
          display: normalized,
          iso_code: iso_code.to_string(),
          variant,
        });
      }
      if trimmed.contains(CURLY_APOSTROPHES) {
        let straight: String = trimmed
          .chars()
          .map(|ch| {
            if CURLY_APOSTROPHES.contains(&ch) {
              '\''
            } else {
              ch
            }
          })
          .collect();
        let straight_norm = normalize_for_search(&straight);
        let straight_key = straight_norm.to_lowercase();
        if seen.insert(straight_key) {
          surfaces.push(CountrySurface {
            display: straight_norm,
            iso_code: iso_code.to_string(),
            variant,
          });
        }
      }
    };

  // Canonical names per language, keyed by alpha-2 code (document order).
  for (_language, per_lang) in &raw.names {
    for (code, name) in per_lang {
      if let Some(name) = name.as_str() {
        register(name, code, BindingCountryVariant::Name);
      }
    }
  }
  // Curated aliases.
  for (iso_code, aliases) in &raw.aliases {
    if let Some(array) = aliases.as_array() {
      for alias in array {
        if let Some(alias) = alias.as_str() {
          register(alias, iso_code, BindingCountryVariant::Alias);
        }
      }
    }
  }

  Ok(Some(surfaces))
}

/// # Errors
///
/// Returns [`AssembleError`] when a backing data file fails to parse.
pub(super) fn build_country_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingCountryMatchData>, AssembleError> {
  Ok(country_surfaces(ctx)?.map(|surfaces| {
    BindingCountryMatchData {
      labels: vec![ENTITY_LABEL.to_string(); surfaces.len()],
      iso_codes: surfaces
        .iter()
        .map(|surface| surface.iso_code.clone())
        .collect(),
      variants: surfaces
        .into_iter()
        .map(|surface| surface.variant)
        .collect(),
    }
  }))
}
