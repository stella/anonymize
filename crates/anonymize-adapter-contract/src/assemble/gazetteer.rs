//! `gazetteer_data` and the gazetteer search patterns.
//!
//! Emitted whenever `config.enableGazetteer && gazetteerEntries.length > 0`:
//! the gazetteer entries come from the caller, never a data file. Every term
//! gets an exact pattern; terms long enough for a typo to stay unambiguous
//! also get a fuzzy pattern whose distance scales with their length. The core
//! matches terms as whole words, folded for case and diacritics and declined.

use std::collections::{BTreeSet, HashMap, HashSet};

use stella_anonymize_core::assemble::{AssembleError, GazetteerEntry};
use stella_anonymize_core::{gazetteer_fuzzy_distance, gazetteer_spelling_key};

use super::AssembleContext;
use super::language::language_config_matches;
use super::legal_forms::gazetteer_legal_form_suffixes;
use super::search_pattern::{fuzzy_pattern, literal_with_options};
use crate::{
  BindingGazetteerInflection, BindingGazetteerMatchData, BindingSearchPattern,
};

/// The label whose spellings also match in person word orders.
const PERSON_LABEL: &str = "person";

/// Edit distance of the fuzzy pattern for `term`, if it gets one; the core
/// owns the length scale so automatic distances resolve the same way.
fn fuzzy_distance(term: &str) -> Option<u32> {
  gazetteer_fuzzy_distance(term).map(u32::from)
}

/// Languages whose case forms and surname derivations the core applies to
/// entry words.
const CZECH_SLOVAK_LANGUAGES: [&str; 2] = ["cs", "sk"];

/// Czech/Slovak forms apply when either language is in the content scope.
/// No configured scope means every language, so the forms stay on.
fn inflection(ctx: &AssembleContext<'_>) -> BindingGazetteerInflection {
  let in_scope = CZECH_SLOVAK_LANGUAGES.iter().any(|language| {
    language_config_matches(language, ctx.content_languages.as_deref())
  });
  if in_scope {
    BindingGazetteerInflection::CzechSlovak
  } else {
    BindingGazetteerInflection::None
  }
}

/// The labels the matchers search for: the pipeline's `labels`, plus the
/// labels hotword rules reclassify into them when those rules are on.
fn search_labels<'a>(ctx: &'a AssembleContext<'_>) -> &'a [String] {
  ctx.allowed_labels.as_deref().unwrap_or_default()
}

/// One search row per distinct canonical or variant string.
struct SearchTerm {
  term: String,
  label: String,
  /// A kept `person` label names the spelling, so person word orders apply
  /// whichever label the row reports.
  person_forms: bool,
}

/// Rows in first-seen order. Spellings the matcher treats as one
/// ([`gazetteer_spelling_key`]) share a label: the first label they were
/// given under in the search-label order ([`search_labels`]), so label
/// filtering never drops a spelling that a kept label names; without a label
/// filter (or with none of its labels kept), the alphabetically first. Either
/// way the label does not depend on entry order.
fn build_search_terms(
  entries: &[GazetteerEntry],
  allowed_labels: &[String],
) -> Vec<SearchTerm> {
  let mut terms: Vec<(&str, String)> = Vec::new();
  let mut seen: HashSet<&str> = HashSet::new();
  let mut labels: HashMap<String, BTreeSet<&str>> = HashMap::new();
  for entry in entries {
    for term in std::iter::once(&entry.canonical).chain(&entry.variants) {
      let key = gazetteer_spelling_key(term);
      labels
        .entry(key.clone())
        .or_default()
        .insert(entry.label.as_str());
      if seen.insert(term.as_str()) {
        terms.push((term.as_str(), key));
      }
    }
  }
  let kept = |label: &str| {
    allowed_labels.is_empty() || allowed_labels.iter().any(|kept| kept == label)
  };
  terms
    .into_iter()
    .filter_map(|(term, key)| {
      let given = labels.get(&key)?;
      let preferred = allowed_labels
        .iter()
        .map(String::as_str)
        .find(|label| given.contains(label));
      let label = preferred.or_else(|| given.first().copied())?;
      Some(SearchTerm {
        term: term.to_owned(),
        label: label.to_owned(),
        person_forms: given.contains(PERSON_LABEL) && kept(PERSON_LABEL),
      })
    })
    .collect()
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
  let terms = build_search_terms(gazetteer, search_labels(ctx));
  let mut labels = Vec::with_capacity(terms.len());
  let mut is_fuzzy = Vec::with_capacity(terms.len());
  let mut row_terms = Vec::with_capacity(terms.len());
  let mut person_forms = Vec::with_capacity(terms.len());
  // Pass 1: exact literals for every term; pass 2: fuzzy patterns for terms
  // long enough.
  let fuzzy_terms = terms
    .iter()
    .filter(|search| fuzzy_distance(&search.term).is_some());
  for (search, fuzzy) in terms
    .iter()
    .map(|search| (search, false))
    .chain(fuzzy_terms.map(|search| (search, true)))
  {
    labels.push(search.label.clone());
    is_fuzzy.push(fuzzy);
    row_terms.push(search.term.clone());
    person_forms.push(search.person_forms);
  }
  // Rows labelled `person` take person word orders anyway; carry the flags
  // only when another row needs them.
  if person_forms
    .iter()
    .zip(&labels)
    .all(|(forms, label)| !forms || label == PERSON_LABEL)
  {
    person_forms.clear();
  }
  Ok(Some(BindingGazetteerMatchData {
    labels,
    is_fuzzy,
    legal_form_suffixes: gazetteer_legal_form_suffixes()?,
    inflection: inflection(ctx),
    terms: row_terms,
    person_forms,
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
  let terms = build_search_terms(gazetteer, search_labels(ctx));
  let mut patterns = Vec::new();
  for search in &terms {
    patterns.push(literal_with_options(search.term.clone(), None, Some(false)));
  }
  for search in &terms {
    if let Some(distance) = fuzzy_distance(&search.term) {
      patterns.push(fuzzy_pattern(search.term.clone(), Some(distance)));
    }
  }
  patterns
}
