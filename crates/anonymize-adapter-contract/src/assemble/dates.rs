//! `date_data`: ports `getDateMonthData` / `getYearWordData` and the
//! `nativeDateData` shaping in `build-unified-search.ts`.
//!
//! Emitted only when regex is on and the "date" label is allowed (the
//! `dateMonthData !== null` gate). `month_names_by_language` filters
//! `date-months.json` by content language and keeps names >= 3 UTF-16 units
//! after stripping a trailing dot; `year_words_by_language` is populated from
//! `year-words.json` only when trigger phrases are enabled.

use std::collections::BTreeMap;

use serde_json::Value;
use stella_anonymize_core::assemble::{
  AssembleError, OrderedMap, parse_ordered_data_file,
};

use super::AssembleContext;
use super::language::{normalize_language_key, selected_language_keys};
use crate::BindingDateData;

const MIN_MONTH_NAME_LENGTH: usize = 3;

/// # Errors
///
/// Returns [`AssembleError`] when `date-months.json` or `year-words.json`
/// fails to parse.
pub(super) fn build_date_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingDateData>, AssembleError> {
  if !(ctx.enable_regex() && ctx.label_allowed("date")) {
    return Ok(None);
  }
  let languages = ctx.content_languages.as_deref();
  let months: OrderedMap<Value> = parse_ordered_data_file("date-months.json")?;
  let month_names_by_language = build_date_month_data(&months, languages);

  let year_words_by_language = if ctx.enable_trigger_phrases() {
    let year_words: OrderedMap<Value> =
      parse_ordered_data_file("year-words.json")?;
    build_year_word_data(&year_words, languages)
  } else {
    BTreeMap::new()
  };

  Ok(Some(BindingDateData {
    month_names_by_language,
    year_words_by_language,
  }))
}

/// Mirrors `filterDateMonthsByLanguage` / `filterYearWordsByLanguage`: keep the
/// language keys in the selection (dropping `_`-prefixed metadata); fall back
/// to the full map when nothing survives.
fn filter_by_language<'a>(
  map: &'a OrderedMap<Value>,
  languages: Option<&[String]>,
) -> Vec<&'a (String, Value)> {
  let Some(selected) = selected_language_keys(languages) else {
    return map.iter().collect();
  };
  let filtered: Vec<&(String, Value)> = map
    .iter()
    .filter(|(key, _)| {
      !key.starts_with('_') && selected.contains(&normalize_language_key(key))
    })
    .collect();
  if filtered.is_empty() {
    map.iter().collect()
  } else {
    filtered
  }
}

/// JS `Array.isArray(value) ? value : [value]`, keeping only string elements.
fn value_to_strings(value: &Value) -> Vec<String> {
  match value {
    Value::Array(items) => items
      .iter()
      .filter_map(|item| item.as_str())
      .map(String::from)
      .collect(),
    Value::String(single) => vec![single.clone()],
    _ => Vec::new(),
  }
}

/// JS `name.replace(/\.$/, "").length` measured in UTF-16 code units.
fn length_without_trailing_dot(name: &str) -> usize {
  let stripped = name.strip_suffix('.').unwrap_or(name);
  stripped.encode_utf16().count()
}

/// Mirrors `buildDateMonthData`: keep every non-`_` language key, filtering its
/// names to those long enough after dropping a trailing dot.
fn build_date_month_data(
  months: &OrderedMap<Value>,
  languages: Option<&[String]>,
) -> BTreeMap<String, Vec<String>> {
  let mut result = BTreeMap::new();
  for (key, value) in filter_by_language(months, languages) {
    if key.starts_with('_') {
      continue;
    }
    let names = value_to_strings(value)
      .into_iter()
      .filter(|name| length_without_trailing_dot(name) >= MIN_MONTH_NAME_LENGTH)
      .collect();
    result.insert(key.clone(), names);
  }
  result
}

/// Mirrors the `getYearWordData` result shaping: non-`_` array keys only, with
/// empty strings dropped.
fn build_year_word_data(
  data: &OrderedMap<Value>,
  languages: Option<&[String]>,
) -> BTreeMap<String, Vec<String>> {
  let mut result = BTreeMap::new();
  for (key, value) in filter_by_language(data, languages) {
    if key.starts_with('_') {
      continue;
    }
    let Some(items) = value.as_array() else {
      continue;
    };
    let words = items
      .iter()
      .filter_map(|item| item.as_str())
      .filter(|word| !word.is_empty())
      .map(String::from)
      .collect();
    result.insert(key.clone(), words);
  }
  result
}
