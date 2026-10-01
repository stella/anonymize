//! `gazetteer_data` and the gazetteer search patterns.
//!
//! Emitted whenever `config.enableGazetteer && gazetteerEntries.length > 0`:
//! the gazetteer entries come from the caller, never a data file. Every term
//! gets an exact pattern; terms long enough for a typo to stay unambiguous
//! also get a fuzzy pattern whose distance scales with their length. The core
//! matches terms as whole words, folded for case and diacritics and declined.

use std::collections::HashMap;

use stella_anonymize_core::assemble::{AssembleError, GazetteerEntry};

use super::AssembleContext;
use super::legal_forms::gazetteer_legal_form_suffixes;
use super::search_pattern::{fuzzy_pattern, literal_with_options};
use crate::{BindingGazetteerMatchData, BindingSearchPattern};

/// Fewer letters than this match only exactly (after folding and declension):
/// one edit turns a short name into an ordinary word (`Acme` -> `acne`).
const MIN_FUZZY_LETTERS: usize = 6;

/// Terms with at least this many letters tolerate two edits; shorter fuzzy
/// terms tolerate one.
const MIN_TWO_EDIT_LETTERS: usize = 10;

/// Longest pattern, in chars, the fuzzy engine accepts.
const MAX_FUZZY_PATTERN_CHARS: usize = 64;

/// Edit distance of the fuzzy pattern for `term`, if it gets one. Terms with
/// digits are identifiers and match only exactly.
fn fuzzy_distance(term: &str) -> Option<u32> {
  if term.chars().any(char::is_numeric)
    || term.chars().count() > MAX_FUZZY_PATTERN_CHARS
  {
    return None;
  }
  match term.chars().filter(|ch| ch.is_alphabetic()).count() {
    letters if letters < MIN_FUZZY_LETTERS => None,
    letters if letters < MIN_TWO_EDIT_LETTERS => Some(1),
    _ => Some(2),
  }
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

/// Exact rows for every term first (`is_fuzzy=false`), then fuzzy rows for
/// terms with a [`fuzzy_distance`] (`is_fuzzy=true`), plus the legal-form
/// suffixes a matched name may extend over.
pub(super) fn build_gazetteer_data(
  ctx: &AssembleContext<'_>,
  gazetteer: &[GazetteerEntry],
) -> Result<Option<BindingGazetteerMatchData>, AssembleError> {
  if !ctx.config.enable_gazetteer || gazetteer.is_empty() {
    return Ok(None);
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
    if fuzzy_distance(term).is_none() {
      continue;
    }
    labels.push(label.clone());
    is_fuzzy.push(true);
  }
  Ok(Some(BindingGazetteerMatchData {
    labels,
    is_fuzzy,
    legal_form_suffixes: gazetteer_legal_form_suffixes()?,
  }))
}

/// Whether `buildGazetteerPatterns` would run (gazResult is non-null).
pub(super) const fn has_gazetteer(
  ctx: &AssembleContext<'_>,
  gazetteer: &[GazetteerEntry],
) -> bool {
  ctx.config.enable_gazetteer && !gazetteer.is_empty()
}

/// Exact `literal-with-options` (wholeWords false; the core checks token
/// boundaries) for every term, then a `fuzzy` pattern for terms with a
/// [`fuzzy_distance`].
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
    if let Some(distance) = fuzzy_distance(term) {
      patterns.push(fuzzy_pattern(term.clone(), Some(distance)));
    }
  }
  patterns
}
