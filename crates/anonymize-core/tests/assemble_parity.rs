//! Golden parity: the Rust assembler must reproduce the TypeScript
//! `buildNativeStaticSearchBundle` output for every field of the native static
//! config.
//!
//! Fixtures are captured by
//! `packages/anonymize/scripts/capture-assemble-fixtures.mjs`. Each
//! `<name>.input.json` holds the `{ config, gazetteer }` inputs; each
//! `<name>.expected.json` holds the full native static config in stable key
//! order. This test compares every field (large arrays via a targeted
//! first-difference report); the companion `assemble_digest` test then proves
//! the assembled config is byte-identical end to end.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use stella_anonymize_adapter_contract::{
  BindingPreparedSearchConfig, assemble_static_search_config,
};
use stella_anonymize_core::assemble::{GazetteerEntry, PipelineConfig};

#[derive(Deserialize)]
struct FixtureInput {
  config: PipelineConfig,
  #[serde(default)]
  gazetteer: Vec<GazetteerEntry>,
}

fn fixtures_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble")
}

fn collect_input_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
  let mut paths = Vec::new();
  let entries =
    fs::read_dir(dir).map_err(|error| format!("read_dir failed: {error}"))?;
  for entry in entries {
    let path = entry.map_err(|error| format!("dir entry: {error}"))?.path();
    let is_input = path
      .file_name()
      .and_then(|name| name.to_str())
      .is_some_and(|name| name.ends_with(".input.json"));
    if is_input {
      paths.push(path);
    }
  }
  paths.sort();
  Ok(paths)
}

fn expected_path_for(input_path: &Path) -> Result<PathBuf, String> {
  let file_name = input_path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| "non-utf8 fixture name".to_string())?;
  let base = file_name
    .strip_suffix(".input.json")
    .ok_or_else(|| format!("unexpected fixture name {file_name}"))?;
  Ok(input_path.with_file_name(format!("{base}.expected.json")))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

/// Compares only the fields slice A assembles. Returns a description of the
/// first mismatch, if any.
fn compare_implemented(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.allowed_labels != expected.allowed_labels {
    return Err(format!(
      "{name}: allowed_labels {:?} != {:?}",
      actual.allowed_labels, expected.allowed_labels
    ));
  }
  if actual.threshold.to_bits() != expected.threshold.to_bits() {
    return Err(format!(
      "{name}: threshold {} != {}",
      actual.threshold, expected.threshold
    ));
  }
  if actual.confidence_boost != expected.confidence_boost {
    return Err(format!(
      "{name}: confidence_boost {} != {}",
      actual.confidence_boost, expected.confidence_boost
    ));
  }
  if actual.custom_regex_patterns != expected.custom_regex_patterns {
    return Err(format!(
      "{name}: custom_regex_patterns {:?} != {:?}",
      actual.custom_regex_patterns, expected.custom_regex_patterns
    ));
  }
  if actual.regex_options != expected.regex_options {
    return Err(format!(
      "{name}: regex_options {:?} != {:?}",
      actual.regex_options, expected.regex_options
    ));
  }
  if actual.custom_regex_options != expected.custom_regex_options {
    return Err(format!(
      "{name}: custom_regex_options {:?} != {:?}",
      actual.custom_regex_options, expected.custom_regex_options
    ));
  }
  if actual.signature_data != expected.signature_data {
    return Err(format!(
      "{name}: signature_data {:?} != {:?}",
      actual.signature_data, expected.signature_data
    ));
  }
  if actual.monetary_data != expected.monetary_data {
    return Err(format!(
      "{name}: monetary_data {:?} != {:?}",
      actual.monetary_data, expected.monetary_data
    ));
  }
  if actual.date_data != expected.date_data {
    return Err(format!(
      "{name}: date_data {:?} != {:?}",
      actual.date_data, expected.date_data
    ));
  }
  if actual.zone_data != expected.zone_data {
    return Err(format!(
      "{name}: zone_data {:?} != {:?}",
      actual.zone_data, expected.zone_data
    ));
  }
  if actual.address_context_data != expected.address_context_data {
    return Err(format!(
      "{name}: address_context_data {:?} != {:?}",
      actual.address_context_data, expected.address_context_data
    ));
  }
  if actual.address_seed_data != expected.address_seed_data {
    return Err(format!(
      "{name}: address_seed_data {:?} != {:?}",
      actual.address_seed_data, expected.address_seed_data
    ));
  }
  if actual.country_data != expected.country_data {
    return Err(format!(
      "{name}: country_data {:?} != {:?}",
      actual.country_data, expected.country_data
    ));
  }
  if actual.hotword_data != expected.hotword_data {
    return Err(format!(
      "{name}: hotword_data {:?} != {:?}",
      actual.hotword_data, expected.hotword_data
    ));
  }
  if actual.custom_regex_meta != expected.custom_regex_meta {
    return Err(format!(
      "{name}: custom_regex_meta {:?} != {:?}",
      actual.custom_regex_meta, expected.custom_regex_meta
    ));
  }
  compare_c2_data(name, actual, expected)?;
  compare_trigger_data(name, actual, expected)?;
  compare_regex_and_legal(name, actual, expected)?;
  compare_c3_data(name, actual, expected)?;
  Ok(())
}

/// Compares two string vectors, reporting the first divergent index.
fn compare_str_vec(
  label: &str,
  got: &[String],
  want: &[String],
) -> Result<(), String> {
  if got.len() != want.len() {
    return Err(format!("{label} length {} != {}", got.len(), want.len()));
  }
  for (index, (g, w)) in got.iter().zip(want.iter()).enumerate() {
    if g != w {
      return Err(format!("{label}[{index}] {g:?} != {w:?}"));
    }
  }
  Ok(())
}

/// Slice C3: the deny-list unit and the literal/slice fields.
fn compare_c3_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.literal_patterns.len() != expected.literal_patterns.len() {
    return Err(format!(
      "{name}: literal_patterns length {} != {}",
      actual.literal_patterns.len(),
      expected.literal_patterns.len()
    ));
  }
  for (index, (got, want)) in actual
    .literal_patterns
    .iter()
    .zip(expected.literal_patterns.iter())
    .enumerate()
  {
    if got != want {
      return Err(format!(
        "{name}: literal_patterns[{index}] differs\n  got:  {got:?}\n  want: {want:?}"
      ));
    }
  }
  if actual.literal_options != expected.literal_options {
    return Err(format!(
      "{name}: literal_options {:?} != {:?}",
      actual.literal_options, expected.literal_options
    ));
  }
  if actual.literal_patterns_from_deny_list_data
    != expected.literal_patterns_from_deny_list_data
  {
    return Err(format!(
      "{name}: literal_patterns_from_deny_list_data {} != {}",
      actual.literal_patterns_from_deny_list_data,
      expected.literal_patterns_from_deny_list_data
    ));
  }
  if actual.slices != expected.slices {
    return Err(format!(
      "{name}: slices {:?} != {:?}",
      actual.slices, expected.slices
    ));
  }
  if actual.name_corpus_mode != expected.name_corpus_mode {
    return Err(format!(
      "{name}: name_corpus_mode {:?} != {:?}",
      actual.name_corpus_mode, expected.name_corpus_mode
    ));
  }
  compare_name_corpus_data(name, actual, expected)?;
  compare_filters(
    &format!("{name}: false_positive_filters"),
    actual.false_positive_filters.as_ref(),
    expected.false_positive_filters.as_ref(),
  )?;
  compare_deny_list_data(name, actual, expected)?;
  Ok(())
}

fn compare_name_corpus_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.name_corpus_data, &expected.name_corpus_data) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      let fields: [(&str, &Vec<String>, &Vec<String>); 15] = [
        ("first_names", &got.first_names, &want.first_names),
        ("surnames", &got.surnames, &want.surnames),
        ("title_tokens", &got.title_tokens, &want.title_tokens),
        (
          "title_abbreviations",
          &got.title_abbreviations,
          &want.title_abbreviations,
        ),
        ("excluded_words", &got.excluded_words, &want.excluded_words),
        ("common_words", &got.common_words, &want.common_words),
        (
          "non_western_names",
          &got.non_western_names,
          &want.non_western_names,
        ),
        (
          "excluded_all_caps",
          &got.excluded_all_caps,
          &want.excluded_all_caps,
        ),
        ("ja_suffixes", &got.ja_suffixes, &want.ja_suffixes),
        (
          "arabic_connectors",
          &got.arabic_connectors,
          &want.arabic_connectors,
        ),
        (
          "relation_connectors",
          &got.relation_connectors,
          &want.relation_connectors,
        ),
        (
          "hyphenated_prefixes",
          &got.hyphenated_prefixes,
          &want.hyphenated_prefixes,
        ),
        (
          "cjk_non_person_terms",
          &got.cjk_non_person_terms,
          &want.cjk_non_person_terms,
        ),
        (
          "cjk_surname_starters",
          &got.cjk_surname_starters,
          &want.cjk_surname_starters,
        ),
        (
          "organization_terms",
          &got.organization_terms,
          &want.organization_terms,
        ),
      ];
      for (field, got_vec, want_vec) in fields {
        compare_str_vec(
          &format!("{name}: name_corpus_data.{field}"),
          got_vec,
          want_vec,
        )?;
      }
      Ok(())
    }
    (got, want) => Err(format!(
      "{name}: name_corpus_data presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_filters(
  label: &str,
  got: Option<&stella_anonymize_adapter_contract::BindingDenyListFilterData>,
  want: Option<&stella_anonymize_adapter_contract::BindingDenyListFilterData>,
) -> Result<(), String> {
  match (got, want) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      let fields: [(&str, &Vec<String>, &Vec<String>); 17] = [
        ("stopwords", &got.stopwords, &want.stopwords),
        ("allow_list", &got.allow_list, &want.allow_list),
        (
          "person_stopwords",
          &got.person_stopwords,
          &want.person_stopwords,
        ),
        (
          "person_trailing_nouns",
          &got.person_trailing_nouns,
          &want.person_trailing_nouns,
        ),
        (
          "address_stopwords",
          &got.address_stopwords,
          &want.address_stopwords,
        ),
        (
          "address_jurisdiction_prefixes",
          &got.address_jurisdiction_prefixes,
          &want.address_jurisdiction_prefixes,
        ),
        ("street_types", &got.street_types, &want.street_types),
        (
          "address_component_terms",
          &got.address_component_terms,
          &want.address_component_terms,
        ),
        (
          "ambiguous_street_type_terms",
          &got.ambiguous_street_type_terms,
          &want.ambiguous_street_type_terms,
        ),
        ("first_names", &got.first_names, &want.first_names),
        ("generic_roles", &got.generic_roles, &want.generic_roles),
        (
          "number_abbrev_prefixes",
          &got.number_abbrev_prefixes,
          &want.number_abbrev_prefixes,
        ),
        (
          "sentence_starters",
          &got.sentence_starters,
          &want.sentence_starters,
        ),
        (
          "trailing_address_word_exclusions",
          &got.trailing_address_word_exclusions,
          &want.trailing_address_word_exclusions,
        ),
        (
          "document_heading_words",
          &got.document_heading_words,
          &want.document_heading_words,
        ),
        (
          "document_heading_ordinal_markers",
          &got.document_heading_ordinal_markers,
          &want.document_heading_ordinal_markers,
        ),
        (
          "defined_term_cues",
          &got.defined_term_cues,
          &want.defined_term_cues,
        ),
      ];
      for (field, got_vec, want_vec) in fields {
        compare_str_vec(&format!("{label}.{field}"), got_vec, want_vec)?;
      }
      if got.signing_place_guards != want.signing_place_guards {
        return Err(format!(
          "{label}.signing_place_guards {:?} != {:?}",
          got.signing_place_guards, want.signing_place_guards
        ));
      }
      Ok(())
    }
    (got, want) => Err(format!(
      "{label} presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_deny_list_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.deny_list_data, &expected.deny_list_data) {
    (None, None) => Ok(()),
    (Some(got), Some(want)) => {
      compare_str_vec(
        &format!("{name}: deny_list_data.originals"),
        &got.originals,
        &want.originals,
      )?;
      compare_str_vec(
        &format!("{name}: deny_list_data.label_table"),
        &got.label_table,
        &want.label_table,
      )?;
      compare_str_vec(
        &format!("{name}: deny_list_data.source_table"),
        &got.source_table,
        &want.source_table,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.label_indices"),
        &got.label_indices,
        &want.label_indices,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.source_indices"),
        &got.source_indices,
        &want.source_indices,
      )?;
      compare_u32_matrix(
        &format!("{name}: deny_list_data.custom_label_indices"),
        &got.custom_label_indices,
        &want.custom_label_indices,
      )?;
      compare_filters(
        &format!("{name}: deny_list_data.filters"),
        got.filters.as_ref(),
        want.filters.as_ref(),
      )?;
      Ok(())
    }
    (got, want) => Err(format!(
      "{name}: deny_list_data presence differs (got {}, want {})",
      got.is_some(),
      want.is_some()
    )),
  }
}

fn compare_u32_matrix(
  label: &str,
  got: &[Vec<u32>],
  want: &[Vec<u32>],
) -> Result<(), String> {
  if got.len() != want.len() {
    return Err(format!("{label} length {} != {}", got.len(), want.len()));
  }
  for (index, (g, w)) in got.iter().zip(want.iter()).enumerate() {
    if g != w {
      return Err(format!("{label}[{index}] {g:?} != {w:?}"));
    }
  }
  Ok(())
}

/// Slice C2 data fields compared field-by-field.
fn compare_c2_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.gazetteer_data != expected.gazetteer_data {
    return Err(format!(
      "{name}: gazetteer_data {:?} != {:?}",
      actual.gazetteer_data, expected.gazetteer_data
    ));
  }
  if actual.coreference_data != expected.coreference_data {
    return Err(format!(
      "{name}: coreference_data {:?} != {:?}",
      actual.coreference_data, expected.coreference_data
    ));
  }
  Ok(())
}

/// Compares `trigger_data` with a targeted first-difference report (the rule
/// array has ~1400 entries, so a full `{:?}` dump is unreadable).
fn compare_trigger_data(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  match (&actual.trigger_data, &expected.trigger_data) {
    (None, None) => return Ok(()),
    (Some(got), Some(want)) => {
      if got.rules.len() != want.rules.len() {
        return Err(format!(
          "{name}: trigger_data.rules length {} != {}",
          got.rules.len(),
          want.rules.len()
        ));
      }
      for (index, (g, w)) in got.rules.iter().zip(want.rules.iter()).enumerate()
      {
        if g != w {
          return Err(format!(
            "{name}: trigger_data.rules[{index}] differs\n  got:  {g:?}\n  want: {w:?}"
          ));
        }
      }
      if got != want {
        return Err(format!(
          "{name}: trigger_data support members differ\n  got:  {:?}\n  want: {:?}",
          TriggerSupport::from(got),
          TriggerSupport::from(want)
        ));
      }
    }
    (got, want) => {
      return Err(format!(
        "{name}: trigger_data presence differs (got {}, want {})",
        got.is_some(),
        want.is_some()
      ));
    }
  }
  Ok(())
}

/// Support-member view of `trigger_data` (rules elided) for readable diffs.
#[derive(Debug)]
#[allow(dead_code)]
struct TriggerSupport<'a> {
  address_stop_keywords: &'a [String],
  party_position_terms: &'a [String],
  post_nominals: &'a [String],
  sentence_terminal_currency_terms: &'a [String],
  phone_extension_labels: &'a [String],
  number_markers: &'a [String],
  number_labels: &'a [String],
}

impl<'a> From<&'a stella_anonymize_adapter_contract::BindingTriggerData>
  for TriggerSupport<'a>
{
  fn from(
    data: &'a stella_anonymize_adapter_contract::BindingTriggerData,
  ) -> Self {
    Self {
      address_stop_keywords: &data.address_stop_keywords,
      party_position_terms: &data.party_position_terms,
      post_nominals: &data.post_nominals,
      sentence_terminal_currency_terms: &data.sentence_terminal_currency_terms,
      phone_extension_labels: &data.phone_extension_labels,
      number_markers: &data.number_markers,
      number_labels: &data.number_labels,
    }
  }
}

/// `regex_meta` (full), `legal_form_data` (full), and the full `regex_patterns`
/// array (static + signing prefix, then legal-form and trigger literal tails).
fn compare_regex_and_legal(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_meta != expected.regex_meta {
    return Err(format!(
      "{name}: regex_meta {:?} != {:?}",
      actual.regex_meta, expected.regex_meta
    ));
  }
  if actual.legal_form_data != expected.legal_form_data {
    return Err(format!(
      "{name}: legal_form_data {:?} != {:?}",
      actual.legal_form_data, expected.legal_form_data
    ));
  }
  compare_regex_patterns(name, actual, expected)
}

/// FULL check for `regex_patterns` with a targeted first-difference report.
fn compare_regex_patterns(
  name: &str,
  actual: &BindingPreparedSearchConfig,
  expected: &BindingPreparedSearchConfig,
) -> Result<(), String> {
  if actual.regex_patterns.len() != expected.regex_patterns.len() {
    return Err(format!(
      "{name}: regex_patterns length {} != {}",
      actual.regex_patterns.len(),
      expected.regex_patterns.len()
    ));
  }
  for (index, (got, want)) in actual
    .regex_patterns
    .iter()
    .zip(expected.regex_patterns.iter())
    .enumerate()
  {
    if got != want {
      return Err(format!(
        "{name}: regex_patterns[{index}] differs\n  got:  {got:?}\n  want: {want:?}"
      ));
    }
  }
  Ok(())
}

fn check_fixture(input_path: &Path) -> Result<(), String> {
  let name = input_path
    .file_name()
    .and_then(|file_name| file_name.to_str())
    .and_then(|file_name| file_name.strip_suffix(".input.json"))
    .unwrap_or("<unknown>");
  let input: FixtureInput = read_json(input_path)?;
  let expected: BindingPreparedSearchConfig =
    read_json(&expected_path_for(input_path)?)?;
  let actual = assemble_static_search_config(
    &input.config,
    input.config.dictionaries.as_ref(),
    &input.gazetteer,
  )
  .map_err(|error| format!("{name}: assemble failed: {error}"))?;
  compare_implemented(name, &actual, &expected)
}

#[test]
fn assemble_parity_matches_typescript() -> Result<(), String> {
  let dir = fixtures_dir();
  let inputs = collect_input_paths(&dir)?;
  if inputs.len() < 30 {
    return Err(format!(
      "expected the captured fixture set, found {} inputs in {}",
      inputs.len(),
      dir.display()
    ));
  }

  let mut failures = Vec::new();
  for input_path in &inputs {
    if let Err(error) = check_fixture(input_path) {
      failures.push(error);
    }
  }
  if failures.is_empty() {
    return Ok(());
  }
  Err(format!(
    "assemble parity mismatches ({} of {}):\n{}",
    failures.len(),
    inputs.len(),
    failures.join("\n")
  ))
}
