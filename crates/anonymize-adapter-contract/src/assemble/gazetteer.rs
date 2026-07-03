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
use super::search_pattern::{fuzzy_pattern, literal_with_options};
use crate::{BindingGazetteerMatchData, BindingSearchPattern};

/// `MAX_EDIT_DISTANCE` from `detectors/gazetteer.ts`.
const MAX_EDIT_DISTANCE: u32 = 2;

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
  // `position[term]` is the index into `terms` for a first-seen term; a later
  // entry reusing the term overwrites its label in place (last-write-wins) but
  // keeps the original insertion position, matching JS `Map` semantics.
  let mut terms: Vec<(String, String)> = Vec::new();
  let mut position: HashMap<String, usize> = HashMap::new();
  for entry in entries {
    let mut set_term = |term: &str| {
      if let Some(&index) = position.get(term) {
        if let Some(slot) = terms.get_mut(index) {
          slot.1.clone_from(&entry.label);
        }
      } else {
        position.insert(term.to_string(), terms.len());
        terms.push((term.to_string(), entry.label.clone()));
      }
    };
    set_term(&entry.canonical);
    for variant in &entry.variants {
      set_term(variant);
    }
  }
  terms
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

/// Whether `buildGazetteerPatterns` would run (gazResult is non-null).
pub(super) const fn has_gazetteer(
  ctx: &AssembleContext<'_>,
  gazetteer: &[GazetteerEntry],
) -> bool {
  ctx.config.enable_gazetteer && !gazetteer.is_empty()
}

/// Mirrors `buildGazetteerPatterns(...).patterns.map(toNativeLiteralPattern)`:
/// exact `literal-with-options` (wholeWords false) for every term, then a
/// `fuzzy` pattern (distance 2) for terms at least [`MIN_FUZZY_LENGTH`] long.
pub(super) fn gazetteer_literal_patterns(
  ctx: &AssembleContext<'_>,
  gazetteer: &[GazetteerEntry],
) -> Vec<BindingSearchPattern> {
  if !has_gazetteer(ctx, gazetteer) {
    return Vec::new();
  }
  let terms = build_search_terms(gazetteer);
  let mut patterns = Vec::new();
  for (term, _) in &terms {
    patterns.push(literal_with_options(term.clone(), None, Some(false)));
  }
  for (term, _) in &terms {
    if utf16_len(term) < MIN_FUZZY_LENGTH {
      continue;
    }
    patterns.push(fuzzy_pattern(term.clone(), Some(MAX_EDIT_DISTANCE)));
  }
  patterns
}
