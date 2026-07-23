#![allow(clippy::expect_used)]

mod support;

use stella_anonymize_core::{
  PatternSlice, PreparedEngine, PreparedEngineConfig, PreparedEngineSlices,
  SearchOptions, SearchPattern, StaticDetectionResult, TriggerData,
  TriggerRule, TriggerStrategy, TriggerValidation,
};
use support::prepared_config;

fn empty_config(slices: PreparedEngineSlices) -> PreparedEngineConfig {
  prepared_config! {
    regex_patterns: vec![],
    custom_regex_patterns: vec![],
    literal_patterns: vec![],
    regex_options: SearchOptions::default(),
    custom_regex_options: SearchOptions::default(),
    literal_options: SearchOptions::default(),
    allowed_labels: vec![],
    threshold: 0.0,
    confidence_boost: false,
    slices: slices,
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
    signature_data: None,
    date_data: None,
    monetary_data: None,
  }
}

fn prepared_for_trigger(
  trigger: &str,
  label: &str,
  strategy: TriggerStrategy,
) -> PreparedEngine {
  prepared_for_trigger_with_support(
    trigger,
    label,
    strategy,
    TriggerSupport::default(),
  )
}

#[derive(Default)]
struct TriggerSupport {
  phone_extension_labels: Vec<String>,
  number_markers: Vec<String>,
  number_labels: Vec<String>,
  person_field_labels: Vec<String>,
}

fn prepared_for_trigger_with_support(
  trigger: &str,
  label: &str,
  strategy: TriggerStrategy,
  support: TriggerSupport,
) -> PreparedEngine {
  PreparedEngine::new(prepared_config! {
    regex_patterns: vec![SearchPattern::LiteralWithOptions {
      pattern: trigger.to_lowercase(),
      case_insensitive: Some(true),
      whole_words: Some(false),
    }],
    slices: PreparedEngineSlices {
      triggers: PatternSlice { start: 0, end: 1 },
      ..PreparedEngineSlices::default()
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
      phone_extension_labels: support.phone_extension_labels,
      number_markers: support.number_markers,
      number_labels: support.number_labels,
      person_field_labels: support.person_field_labels,
    }),
    ..empty_config(PreparedEngineSlices::default())
  })
  .expect("trigger config should prepare")
}

fn trigger_texts(result: &StaticDetectionResult) -> Vec<&str> {
  result
    .entities
    .trigger()
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
      result.entities.trigger(),
    );
  }
}

#[test]
fn company_id_trigger_uses_configured_number_labels() {
  let prepared = prepared_for_trigger_with_support(
    "KRS",
    "registration number",
    TriggerStrategy::CompanyIdValue,
    TriggerSupport {
      number_labels: vec![String::from("nr.")],
      ..TriggerSupport::default()
    },
  );

  let result = prepared
    .detect_static_entities("KRS nr. 0000123456")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["0000123456"]);
}

#[test]
fn n_words_trigger_skips_configured_number_markers() {
  let prepared = prepared_for_trigger_with_support(
    "case",
    "matter id",
    TriggerStrategy::NWords { count: 2 },
    TriggerSupport {
      number_markers: vec![String::from("no")],
      ..TriggerSupport::default()
    },
  );

  let result = prepared
    .detect_static_entities("case no ABC 123")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["ABC 123"]);
}

#[test]
fn n_words_trigger_advances_across_multibyte_whitespace() {
  let prepared = prepared_for_trigger(
    "case",
    "matter id",
    TriggerStrategy::NWords { count: 2 },
  );

  let result = prepared
    .detect_static_entities("case ABC\u{00a0}123")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["ABC\u{00a0}123"]);
}

#[test]
fn labelled_phone_trigger_keeps_extension_suffixes() {
  let prepared = prepared_for_trigger_with_support(
    "PHONE",
    "phone number",
    TriggerStrategy::ToEndOfLine,
    TriggerSupport {
      phone_extension_labels: vec![
        String::from("extension"),
        String::from("ext"),
        String::from("x"),
      ],
      ..TriggerSupport::default()
    },
  );

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
      result.entities.trigger(),
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

  assert!(rejected.entities.trigger().is_empty());
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
    result.entities.trigger(),
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
  let prepared = prepared_for_trigger_with_support(
    "DNI",
    "national identification number",
    TriggerStrategy::CompanyIdValue,
    TriggerSupport {
      number_labels: vec![String::from("no")],
      ..TriggerSupport::default()
    },
  );

  let result = prepared
    .detect_static_entities("DNI 6.11.2025")
    .expect("static detection should succeed");

  assert!(result.entities.trigger().is_empty());
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

  assert!(rejected.entities.trigger().is_empty());
  assert_eq!(trigger_texts(&accepted), ["AB12345"]);
}

#[test]
fn company_id_trigger_consumes_complete_alphanumeric_identifier() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  for value in [
    "ABCD-12345",
    "12345-ABCD",
    "ABCD/12345.XY",
    "FR A1 123456789",
  ] {
    let text = format!("Patient number: {value}, next field");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert_eq!(trigger_texts(&result), [value]);
  }
}

#[test]
fn company_id_trigger_rejects_partial_or_overlong_identifier() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );
  let overlong = format!("AB-{}", "1".repeat(129));

  for value in ["12345-", "ABCD-12345_tail", overlong.as_str()] {
    let text = format!("Patient number: {value}");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert!(
      result.entities.trigger().is_empty(),
      "must not redact a partial prefix of {value:?}"
    );
  }
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
    result.entities.trigger(),
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

#[test]
fn match_pattern_trigger_with_lookahead_matches_through_bounded_engine() {
  // A lookaround pattern rides the bounded backtracking arm of the regex
  // wrapper; the triggered value must extract exactly as before.
  let prepared = prepared_for_trigger(
    "Amount",
    "monetary amount",
    TriggerStrategy::MatchPattern {
      pattern: String::from(r"\d{3}(?= CZK)"),
      flags: None,
    },
  );

  let result = prepared
    .detect_static_entities("Amount: 123 CZK due")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["123"]);
}

#[test]
fn match_pattern_trigger_surfaces_backtrack_budget_exhaustion() {
  // A catastrophic pattern/input pair must surface as a typed error from
  // detection — not hang, and not silently read as "no match" while the
  // triggered value stays uncovered.
  let prepared = prepared_for_trigger(
    "Ref",
    "registration number",
    TriggerStrategy::MatchPattern {
      pattern: String::from(r"(a+)+\1$"),
      flags: None,
    },
  );
  let text = format!("Ref: {}c", "a".repeat(40));

  let error = prepared
    .detect_static_entities(&text)
    .expect_err("the backtrack budget must surface as an error");

  assert!(
    error.to_string().to_lowercase().contains("backtrack"),
    "unexpected error: {error}"
  );
}
