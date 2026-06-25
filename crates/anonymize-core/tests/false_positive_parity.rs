#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::BTreeSet;

use stella_anonymize_core::{
  DenyListFilterData, DenyListMatchData, OperatorConfig, PatternSlice,
  PreparedSearch, PreparedSearchConfig, PreparedSearchSlices, RegexMatchMeta,
  SearchOptions, SearchPattern, TriggerData, TriggerRule, TriggerStrategy,
};

fn empty_config(slices: PreparedSearchSlices) -> PreparedSearchConfig {
  PreparedSearchConfig {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    gazetteer_data: None,
    country_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn empty_deny_list_data(filters: DenyListFilterData) -> DenyListMatchData {
  DenyListMatchData {
    labels: Vec::<Vec<String>>::new().into(),
    custom_labels: Vec::<Vec<String>>::new().into(),
    originals: vec![],
    sources: Vec::<Vec<String>>::new().into(),
    filters: Some(filters),
  }
}

fn set<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
  values.into_iter().map(String::from).collect()
}

fn resolved_texts(prepared: &PreparedSearch, text: &str) -> Vec<String> {
  prepared
    .redact_static_entities(text, &OperatorConfig::default())
    .unwrap()
    .resolved_entities
    .into_iter()
    .map(|entity| entity.text)
    .collect()
}

#[test]
fn keeps_trigger_address_with_extra_component_anchor() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("bytem"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: String::from("bytem"),
        label: String::from("address"),
        strategy: TriggerStrategy::Address {
          max_chars: Some(80),
        },
        validations: Vec::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      sentence_terminal_currency_terms: Vec::new(),
    }),
    deny_list_data: Some(empty_deny_list_data(DenyListFilterData {
      address_component_terms: set(["sídliště"]),
      ..DenyListFilterData::default()
    })),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  assert_eq!(
    resolved_texts(&prepared, "Trvale bytem: sídliště Barrandov."),
    [String::from("sídliště Barrandov")]
  );
}

#[test]
fn rejects_non_trigger_numbers_after_number_abbreviations() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(r"\b\d{4}\b"))],
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("registration number", 0.9)],
    deny_list_data: Some(empty_deny_list_data(DenyListFilterData {
      number_abbrev_prefixes: set(["no.", "č.", "nr."]),
      ..DenyListFilterData::default()
    })),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let text = "Invoice No. 1234, položka č. 5678, Akte Nr. 9012, account 7777.";

  assert_eq!(resolved_texts(&prepared, text), [String::from("7777")]);
}

#[test]
fn rejects_document_structure_heading_organizations() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::Regex(String::from(
      r"Schedule No\. 4|Příloha č\. 2|Acme No\. 4",
    ))],
    slices: PreparedSearchSlices {
      regex: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    regex_meta: vec![RegexMatchMeta::new("organization", 0.9)],
    deny_list_data: Some(empty_deny_list_data(DenyListFilterData {
      document_heading_words: set(["schedule", "příloha"]),
      document_heading_ordinal_markers: set(["no.", "č."]),
      ..DenyListFilterData::default()
    })),
    ..empty_config(PreparedSearchSlices::default())
  })
  .unwrap();

  let text = "Schedule No. 4\nPříloha č. 2\nAcme No. 4 signed.";

  assert_eq!(
    resolved_texts(&prepared, text),
    [String::from("Acme No. 4")]
  );
}
