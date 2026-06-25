#![allow(clippy::expect_used)]

use stella_anonymize_core::{
  AddressSeedData, LiteralSearchOptions, OperatorConfig, PatternSlice,
  PreparedSearch, PreparedSearchConfig, PreparedSearchSlices, SearchOptions,
  SearchPattern,
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

fn address_texts(
  result: &stella_anonymize_core::StaticRedactionResult,
) -> Vec<&str> {
  result
    .resolved_entities
    .iter()
    .filter(|entity| entity.label == "address")
    .map(|entity| entity.text.as_str())
    .collect()
}

#[test]
fn detects_state_qualified_zip_plus_four_address_seed() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    address_seed_data: Some(AddressSeedData::default()),
    ..empty_config(PreparedSearchSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Registered office: CA 94304-1050. Notices follow.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"CA 94304-1050"),
    "resolved address entities: {:?}",
    result.resolved_entities,
  );
  assert!(!result.redaction.redacted_text.contains("94304-1050"));
}

#[test]
fn detects_cue_gated_br_cep_address_seed() {
  let prepared = PreparedSearch::new(PreparedSearchConfig {
    literal_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: String::from("Rua"),
      case_insensitive: Some(true),
      whole_words: Some(true),
    }],
    literal_options: SearchOptions {
      literal: LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      ..SearchOptions::default()
    },
    slices: PreparedSearchSlices {
      street_types: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    address_seed_data: Some(AddressSeedData {
      boundary_words: Vec::new(),
      br_cep_cue_words: vec![String::from("CEP")],
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .expect("address seed data should prepare");

  let result = prepared
    .redact_static_entities(
      "Enviar para CEP 01001-000, Rua Boa Vista, 100. Obrigado.",
      &OperatorConfig::default(),
    )
    .expect("static redaction should succeed");

  assert!(
    address_texts(&result).contains(&"CEP 01001-000, Rua Boa Vista, 100"),
    "resolved address entities: {:?}",
    result.resolved_entities,
  );
  assert!(!result.redaction.redacted_text.contains("01001-000"));
}
