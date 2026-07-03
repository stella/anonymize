//! `country_data`: ports `buildCountryPatterns` (`detectors/countries.ts`).
//!
//! The binding `country_data` field carries only the per-pattern `labels`
//! (always `"country"`), so parity reduces to reproducing the number of unique
//! registered surface forms. That count is driven by the same normalize +
//! lowercase-key + blocklist + apostrophe-variant registration the TypeScript
//! source performs; alpha-2/alpha-3 codes stay disabled (`INCLUDE_ALPHA2` /
//! `INCLUDE_ALPHA3` are `false`). Emitted when countries are not explicitly
//! disabled and the "country" label is allowed.
//!
//! NOTE: `isoCodes` and `variants` from `CountryData` are not represented in
//! the binding `country_data` type, so they are neither produced nor compared
//! here; the surface strings themselves are verified downstream via
//! `literal_patterns` (a later slice).

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use stella_anonymize_core::assemble::{AssembleError, parse_data_file};
use stella_anonymize_core::normalize_for_search;

use super::AssembleContext;
use crate::BindingCountryMatchData;

const ENTITY_LABEL: &str = "country";
const CURLY_APOSTROPHES: [char; 2] = ['\u{2018}', '\u{2019}'];

#[derive(Deserialize)]
struct RawCountryData {
  #[serde(default)]
  names: HashMap<String, HashMap<String, String>>,
  #[serde(default)]
  aliases: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct AmbiguousSurfaces {
  #[serde(default)]
  words: Vec<String>,
}

/// # Errors
///
/// Returns [`AssembleError`] when `countries.json` or
/// `ambiguous-country-surfaces.json` fails to parse.
pub(super) fn build_country_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingCountryMatchData>, AssembleError> {
  if ctx.config.enable_countries == Some(false) || !ctx.label_allowed("country")
  {
    return Ok(None);
  }
  let raw: RawCountryData = parse_data_file("countries.json")?;
  let ambiguous: AmbiguousSurfaces =
    parse_data_file("ambiguous-country-surfaces.json")?;
  let blocklist: HashSet<String> = ambiguous
    .words
    .iter()
    .map(|word| word.to_lowercase())
    .collect();

  let mut keys: HashSet<String> = HashSet::new();
  for per_language in raw.names.values() {
    for name in per_language.values() {
      register(name, &blocklist, &mut keys);
    }
  }
  for aliases in raw.aliases.values() {
    for alias in aliases {
      register(alias, &blocklist, &mut keys);
    }
  }

  Ok(Some(BindingCountryMatchData {
    labels: vec![ENTITY_LABEL.to_string(); keys.len()],
  }))
}

/// Mirrors `register`: normalize, lowercase the dedup key, drop blocklisted
/// surfaces, and register a straight-apostrophe variant when the surface has a
/// curly one. Only the set of distinct keys matters for the label count.
fn register(
  surface: &str,
  blocklist: &HashSet<String>,
  keys: &mut HashSet<String>,
) {
  let trimmed = surface.trim();
  if trimmed.is_empty() {
    return;
  }
  let key = normalize_for_search(trimmed).to_lowercase();
  if blocklist.contains(&key) {
    return;
  }
  keys.insert(key);
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
    keys.insert(normalize_for_search(&straight).to_lowercase());
  }
}
