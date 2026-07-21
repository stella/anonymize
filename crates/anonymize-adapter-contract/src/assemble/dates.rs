//! `date_data`: ports `getDateMonthData` / `getYearWordData` and the
//! `nativeDateData` shaping in `build-unified-search.ts`.
//!
//! Emitted only when regex is on and the "date" label is allowed (the
//! `dateMonthData !== null` gate). `month_names_by_language` filters
//! `date-months.json` by content language and keeps names >= 3 UTF-16 units
//! after stripping a trailing dot. Lowercase ambiguity metadata stays scoped
//! to the same selected languages. `year_words_by_language` is populated from
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
/// Returns [`AssembleError`] when date vocabulary data fails to parse.
pub(super) fn build_date_data(
  ctx: &AssembleContext<'_>,
) -> Result<Option<BindingDateData>, AssembleError> {
  if !(ctx.enable_regex() && ctx.label_allowed("date")) {
    return Ok(None);
  }
  let languages = ctx.content_languages.as_deref();
  let months: OrderedMap<Value> = parse_ordered_data_file("date-months.json")?;
  let month_names_by_language = build_date_month_data(&months, languages);
  let lowercase_ambiguities: OrderedMap<Value> =
    parse_ordered_data_file("date-month-lowercase-ambiguities.json")?;
  let lowercase_month_ambiguities =
    build_date_month_data(&lowercase_ambiguities, languages);

  let year_words_by_language = if ctx.enable_trigger_phrases() {
    let year_words: OrderedMap<Value> =
      parse_ordered_data_file("year-words.json")?;
    build_year_word_data(&year_words, languages)
  } else {
    BTreeMap::new()
  };

  Ok(Some(BindingDateData {
    month_names_by_language,
    lowercase_month_ambiguities,
    year_words_by_language,
  }))
}

/// Keeps only selected language keys, dropping `_`-prefixed metadata. An
/// absent selection means all languages; an unsupported explicit language
/// stays empty instead of importing unrelated vocabularies.
fn filter_by_language<'a>(
  map: &'a OrderedMap<Value>,
  languages: Option<&[String]>,
) -> Vec<&'a (String, Value)> {
  let Some(selected) = selected_language_keys(languages) else {
    return map.iter().collect();
  };
  map
    .iter()
    .filter(|(key, _)| {
      !key.starts_with('_') && selected.contains(&normalize_language_key(key))
    })
    .collect()
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

#[cfg(test)]
mod tests {
  use stella_anonymize_core::assemble::parse_ordered_data_file;

  use super::{OrderedMap, Value, build_date_month_data};

  #[test]
  fn lowercase_ambiguities_remain_language_scoped()
  -> Result<(), stella_anonymize_core::assemble::AssembleError> {
    let data: OrderedMap<Value> =
      parse_ordered_data_file("date-month-lowercase-ambiguities.json")?;

    let english = build_date_month_data(&data, Some(&[String::from("en")]));
    let spanish = build_date_month_data(&data, Some(&[String::from("es")]));

    assert_eq!(
      english.keys().map(String::as_str).collect::<Vec<_>>(),
      ["en"]
    );
    assert_eq!(
      spanish.keys().map(String::as_str).collect::<Vec<_>>(),
      ["es"]
    );
    assert!(
      spanish.get("es").is_some_and(|ambiguities| ambiguities
        .iter()
        .any(|word| word == "set"))
    );
    assert!(spanish.get("es").is_some_and(|ambiguities| {
      !ambiguities.iter().any(|word| word == "march")
    }));
    Ok(())
  }

  #[test]
  fn unsupported_language_does_not_import_other_month_vocabularies()
  -> Result<(), stella_anonymize_core::assemble::AssembleError> {
    let data: OrderedMap<Value> = parse_ordered_data_file("date-months.json")?;

    let japanese = build_date_month_data(&data, Some(&[String::from("ja")]));

    assert!(japanese.is_empty());
    Ok(())
  }
}
