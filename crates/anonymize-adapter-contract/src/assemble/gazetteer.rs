//! `gazetteer_data`: ports `buildSearchTerms` + `buildGazetteerPatterns`
//! (`detectors/gazetteer.ts:46`) and the `toNativeGazetteerData` copy
//! (`build-unified-search.ts:1565`).
//!
//! Emitted whenever `config.enableGazetteer && gazetteerEntries.length > 0`
//! (`build-unified-search.ts:968`): the gazetteer entries come from the caller,
//! never a data file.

use std::collections::HashMap;

use stella_anonymize_core::assemble::GazetteerEntry;

use super::AssembleContext;
use crate::BindingGazetteerMatchData;

/// `MIN_FUZZY_LENGTH` from `detectors/gazetteer.ts`.
const MIN_FUZZY_LENGTH: usize = 4;

/// JS `String.prototype.length`: UTF-16 code-unit count, so the fuzzy-length
/// gate (`term.length < MIN_FUZZY_LENGTH`) ties exactly to the TypeScript
/// source for astral / non-BMP terms.
fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

/// Mirrors `buildSearchTerms`: a `Map<term, { label }>` keyed by canonical and
/// variant strings. JS `Map` keeps first-insertion order but last-write-wins
/// for the value, so a term reused by a later entry keeps its original position
/// while its label is overwritten.
fn build_search_terms(entries: &[GazetteerEntry]) -> Vec<(String, String)> {
  let mut order: Vec<String> = Vec::new();
  let mut labels: HashMap<String, String> = HashMap::new();
  let mut set_term = |term: &str, label: &str, order: &mut Vec<String>| {
    if !labels.contains_key(term) {
      order.push(term.to_string());
    }
    labels.insert(term.to_string(), label.to_string());
  };
  for entry in entries {
    set_term(&entry.canonical, &entry.label, &mut order);
    for variant in &entry.variants {
      set_term(variant, &entry.label, &mut order);
    }
  }
  order
    .into_iter()
    .map(|term| {
      let label = labels.get(&term).cloned().unwrap_or_default();
      (term, label)
    })
    .collect()
}

/// Mirrors `buildGazetteerPatterns` + `toNativeGazetteerData`: exact labels for
/// every term first (`isFuzzy=false`), then fuzzy labels for terms whose UTF-16
/// length is at least [`MIN_FUZZY_LENGTH`] (`isFuzzy=true`).
pub(super) fn build_gazetteer_data(
  ctx: &AssembleContext<'_>,
  gazetteer: &[GazetteerEntry],
) -> Option<BindingGazetteerMatchData> {
  if !ctx.config.enable_gazetteer || gazetteer.is_empty() {
    return None;
  }
  let terms = build_search_terms(gazetteer);
  let mut labels = Vec::with_capacity(terms.len());
  let mut is_fuzzy = Vec::with_capacity(terms.len());
  // Pass 1: exact literals for every term.
  for (_, label) in &terms {
    labels.push(label.clone());
    is_fuzzy.push(false);
  }
  // Pass 2: fuzzy patterns for terms long enough.
  for (term, label) in &terms {
    if utf16_len(term) < MIN_FUZZY_LENGTH {
      continue;
    }
    labels.push(label.clone());
    is_fuzzy.push(true);
  }
  Some(BindingGazetteerMatchData { labels, is_fuzzy })
}
