//! Language-scope helpers shared by the templating field builders.
//!
//! Ports `configuredContentLanguages` (`language-scope.ts`) plus the two
//! per-field language matchers used by the ported getters:
//! `selectedLanguageKeys` (`detectors/regex.ts`, date scoping) and
//! `signingClauseLanguageMatches` (`build-unified-search.ts`, zone scoping).
//! `applyPipelineLanguageScope` is intentionally not ported here: it only
//! rewrites `nameCorpusLanguages` / `denyListCountries`, neither of which
//! affects any field this slice assembles.

use std::collections::HashSet;

use serde_json::Value;
use stella_anonymize_core::assemble::{OrderedMap, PipelineConfig};

/// Mirrors `configuredContentLanguages`: prefer `languages` (even when empty),
/// fall back to the single `language`, else `None` for "all languages".
pub(super) fn configured_content_languages(
  config: &PipelineConfig,
) -> Option<Vec<String>> {
  if let Some(languages) = config.languages.as_ref() {
    return Some(languages.clone());
  }
  config
    .language
    .as_ref()
    .map(|language| vec![language.clone()])
}

/// Mirrors `normalizeLanguageKey`: JS `language.trim().toLowerCase()`.
pub(super) fn normalize_language_key(language: &str) -> String {
  language.trim().to_lowercase()
}

/// Mirrors `selectedLanguageKeys`: the normalized selection plus each base
/// language (before `-`), or `None` when nothing usable was selected.
pub(super) fn selected_language_keys(
  languages: Option<&[String]>,
) -> Option<HashSet<String>> {
  let languages = languages?;
  if languages.is_empty() {
    return None;
  }
  let mut selected = HashSet::new();
  for language in languages {
    let normalized = normalize_language_key(language);
    if normalized.is_empty() {
      continue;
    }
    if let Some((base, _)) = normalized.split_once('-') {
      selected.insert(base.to_string());
    }
    selected.insert(normalized);
  }
  if selected.is_empty() {
    None
  } else {
    Some(selected)
  }
}

/// Mirrors `baseLanguage`: the segment before the first `-`, or the whole
/// string when there is none.
fn base_language(language: &str) -> &str {
  language.split('-').next().unwrap_or(language)
}

/// Mirrors `languageConfigMatches` from `util/language-selection.ts`.
pub(super) fn language_config_matches(
  config_language: &str,
  selected: Option<&[String]>,
) -> bool {
  let Some(selected) = selected else {
    return true;
  };
  let normalized_selected: Vec<String> = selected
    .iter()
    .map(|language| normalize_language_key(language))
    .filter(|language| !language.is_empty())
    .collect();
  if normalized_selected.is_empty() {
    return true;
  }
  let normalized_config = normalize_language_key(config_language);
  if normalized_config.is_empty() {
    return false;
  }
  let generic_config = base_language(&normalized_config) == normalized_config;
  normalized_selected.iter().any(|language| {
    language == &normalized_config
      || (generic_config && base_language(language) == normalized_config)
  })
}

/// Mirrors `languageKeyedTerms`: concatenate the array values of every language
/// that matches the selection (`und` always matches), then dedup by exact
/// string keeping first-occurrence order (`uniqueStrings`).
pub(super) fn language_keyed_terms(
  values: &OrderedMap<Value>,
  selected: Option<&[String]>,
) -> Vec<String> {
  let mut result = Vec::new();
  let mut seen = HashSet::new();
  for (language, terms) in values {
    let Some(terms) = terms.as_array() else {
      continue;
    };
    if language != "und" && !language_config_matches(language, selected) {
      continue;
    }
    for term in terms {
      let Some(term) = term.as_str() else {
        continue;
      };
      if seen.insert(term.to_string()) {
        result.push(term.to_string());
      }
    }
  }
  result
}

/// Mirrors `signingClauseLanguageMatches`: no selection matches everything;
/// otherwise the entry language must equal a selected language or its base.
pub(super) fn signing_clause_language_matches(
  entry_language: &str,
  selected: Option<&[String]>,
) -> bool {
  let Some(selected) = selected else {
    return true;
  };
  if selected.is_empty() {
    return true;
  }
  let normalized_entry = entry_language.to_lowercase();
  selected.iter().any(|language| {
    let normalized = language.trim().to_lowercase();
    normalized == normalized_entry
      || normalized.split('-').next() == Some(normalized_entry.as_str())
  })
}
