#![allow(clippy::expect_used)]

use stella_anonymize_core::{
  PatternSlice, PreparedSearch, PreparedSearchConfig, PreparedSearchSlices,
  SearchOptions, SearchPattern, StaticDetectionResult, TriggerData,
  TriggerRule, TriggerStrategy, TriggerValidation,
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
    confidence_boost: false,
    slices,
    regex_meta: vec![],
    custom_regex_meta: vec![],
    deny_list_data: None,
    false_positive_filters: None,
    gazetteer_data: None,
    country_data: None,
    hotword_data: None,
    trigger_data: None,
    legal_form_data: None,
    address_seed_data: None,
    zone_data: None,
    address_context_data: None,
    coreference_data: None,
    name_corpus_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn prepared_for_trigger(
  trigger: &str,
  label: &str,
  strategy: TriggerStrategy,
) -> PreparedSearch {
  PreparedSearch::new(PreparedSearchConfig {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: trigger.to_lowercase(),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedSearchSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedSearchSlices::default()
    },
    trigger_data: Some(TriggerData {
      rules: vec![TriggerRule {
        trigger: trigger.to_owned(),
        label: label.to_owned(),
        strategy,
        validations: Vec::<TriggerValidation>::new(),
        include_trigger: false,
      }],
      address_stop_keywords: Vec::new(),
      party_position_terms: Vec::new(),
      legal_form_suffixes: Vec::new(),
      post_nominals: vec![
        String::from("Ph.D."),
        String::from("CSc."),
        String::from("MBA"),
      ],
      sentence_terminal_currency_terms: vec![String::from("Kč")],
    }),
    ..empty_config(PreparedSearchSlices::default())
  })
  .expect("trigger config should prepare")
}

fn trigger_texts(result: &StaticDetectionResult) -> Vec<&str> {
  result
    .trigger_entities
    .iter()
    .map(|entity| entity.text.as_str())
    .collect()
}

#[test]
fn uppercase_configured_id_triggers_accept_lowercase_source_forms() {
  for (trigger, text, expected) in [
    ("CPF", "cpf: 123.456.789-00", "123.456.789-00"),
    ("CNPJ", "cnpj: 12.345.678/0001-95", "12.345.678/0001-95"),
    ("DNI", "dni 12345678Z", "12345678Z"),
    ("CP", "cp: 08001", "08001"),
  ] {
    let prepared = prepared_for_trigger(
      trigger,
      "tax identification number",
      TriggerStrategy::CompanyIdValue,
    );
    let result = prepared
      .detect_static_entities(text)
      .expect("static detection should succeed");

    assert!(
      trigger_texts(&result).contains(&expected),
      "trigger {trigger} should extract {expected:?}; entities: {:?}",
      result.trigger_entities,
    );
  }
}

#[test]
fn labelled_phone_trigger_keeps_extension_suffixes() {
  let prepared =
    prepared_for_trigger("PHONE", "phone number", TriggerStrategy::ToEndOfLine);

  for (text, expected) in [
    (
      "PHONE: +1 555 123 4567 ext. 89\nNext line.",
      "+1 555 123 4567 ext. 89",
    ),
    (
      "PHONE: +1 555 123 4567 extension 42\nNext line.",
      "+1 555 123 4567 extension 42",
    ),
    (
      "PHONE: +1 555 123 4567 x42\nNext line.",
      "+1 555 123 4567 x42",
    ),
  ] {
    let result = prepared
      .detect_static_entities(text)
      .expect("static detection should succeed");

    assert!(
      trigger_texts(&result).contains(&expected),
      "phone trigger should keep extension in {expected:?}; entities: {:?}",
      result.trigger_entities,
    );
  }
}

#[test]
fn labelled_phone_trigger_stops_before_numbered_sentences() {
  let prepared =
    prepared_for_trigger("PHONE", "phone number", TriggerStrategy::ToEndOfLine);

  let result = prepared
    .detect_static_entities("PHONE: +36 1 234 5678. 1. Definitions")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["+36 1 234 5678"]);
}

#[test]
fn person_trigger_only_skips_known_post_nominals_after_comma() {
  let prepared = prepared_for_trigger(
    "represented by",
    "person",
    TriggerStrategy::ToNextComma {
      stop_words: Vec::new(),
      max_length: Some(100),
    },
  );

  let prose = prepared
    .detect_static_entities("represented by John Smith, and shall continue.")
    .expect("static detection should succeed");
  let degree = prepared
    .detect_static_entities(
      "represented by John Smith, Ph.D., and shall continue.",
    )
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&prose), ["John Smith"]);
  assert_eq!(trigger_texts(&degree), ["John Smith, Ph.D."]);
}

#[test]
fn match_pattern_trigger_requires_match_at_value_start() {
  let prepared = prepared_for_trigger(
    "Telephone",
    "phone number",
    TriggerStrategy::MatchPattern {
      pattern: String::from(r"\d+"),
      flags: None,
    },
  );

  let rejected = prepared
    .detect_static_entities("Telephone : non communique SIREN : 123456789")
    .expect("static detection should succeed");
  let accepted = prepared
    .detect_static_entities("Telephone : 123456789 SIREN")
    .expect("static detection should succeed");

  assert!(rejected.trigger_entities.is_empty());
  assert_eq!(trigger_texts(&accepted), ["123456789"]);
}

#[test]
fn to_next_comma_stops_after_short_currency_abbreviation_sentence_tail() {
  let prepared = prepared_for_trigger(
    "fee",
    "monetary amount",
    TriggerStrategy::ToNextComma {
      stop_words: Vec::new(),
      max_length: Some(100),
    },
  );

  let result = prepared
    .detect_static_entities("fee 100 Kč. Termin splatnosti je zítra.")
    .expect("static detection should succeed");

  assert!(
    trigger_texts(&result).contains(&"100 Kč"),
    "currency sentence tail should stop the capture; entities: {:?}",
    result.trigger_entities,
  );
}

#[test]
fn to_next_comma_stops_on_unicode_case_stop_words() {
  let prepared = prepared_for_trigger(
    "court",
    "organization",
    TriggerStrategy::ToNextComma {
      stop_words: vec![String::from("dňa")],
      max_length: Some(100),
    },
  );

  let result = prepared
    .detect_static_entities("court Okresný súd DŇA 1.1.2025, other text.")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), [String::from("Okresný súd")]);
}

#[test]
fn company_id_trigger_rejects_single_digit_dotted_date() {
  let prepared = prepared_for_trigger(
    "DNI",
    "national identification number",
    TriggerStrategy::CompanyIdValue,
  );

  let result = prepared
    .detect_static_entities("DNI 6.11.2025")
    .expect("static detection should succeed");

  assert!(result.trigger_entities.is_empty());
}

#[test]
fn company_id_trigger_caps_leading_alpha_prefixes() {
  let prepared = prepared_for_trigger(
    "Company No.",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  let rejected = prepared
    .detect_static_entities("Company No. ReferenceCode12345")
    .expect("static detection should succeed");
  let accepted = prepared
    .detect_static_entities("Company No. AB12345")
    .expect("static detection should succeed");

  assert!(rejected.trigger_entities.is_empty());
  assert_eq!(trigger_texts(&accepted), ["AB12345"]);
}

#[test]
fn address_trigger_stops_after_short_proper_noun_before_real_sentence() {
  let prepared = prepared_for_trigger(
    "office",
    "address",
    TriggerStrategy::Address {
      max_chars: Some(120),
    },
  );

  let result = prepared
    .detect_static_entities("office Brno. Section begins here.")
    .expect("static detection should succeed");

  assert!(
    trigger_texts(&result).contains(&"Brno"),
    "proper-noun sentence tail should stop the address; entities: {:?}",
    result.trigger_entities,
  );
}

#[test]
fn trigger_lookahead_counts_text_units_not_utf8_bytes() {
  let prepared = prepared_for_trigger(
    "residing at",
    "address",
    TriggerStrategy::Address {
      max_chars: Some(120),
    },
  );
  let dense_prefix = "京".repeat(90);
  let expected = format!("{dense_prefix} Main Street 1");
  let text = format!("residing at {expected}\nNext line.");

  let result = prepared
    .detect_static_entities(&text)
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), [expected]);
}
