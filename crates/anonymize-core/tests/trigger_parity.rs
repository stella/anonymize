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
  let place_after_short_trigger = prepared
    .detect_static_entities("Company No. Paris 123456789")
    .expect("static detection should succeed");

  assert!(rejected.entities.trigger().is_empty());
  assert!(place_after_short_trigger.entities.trigger().is_empty());
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
    "ABCD123 CD456",
    "ABCD123 CD-456",
    "ABCD123 456",
    "ABCD123 456 789",
    "ABCD123 67",
    "ABCD123 678",
    "ABCD123 6789",
    "ABCD123 2025",
    "ABCD123 67890",
    "ABCD123 456A",
    "ABCD123 456ABCD",
    "ABCD123 ABCD456",
    "ABCD123 456ABCDEFGHIJKL",
    "ABCD123 ABCDEFGHIJKL456",
    "ABCD123 ABCD-456",
    "ABCDEFGHIJKL123 456",
    "123-45 67",
    "123-45 678",
    "123-45 6789",
    "123-45 2025",
    "123-45 67890",
    "123-45 456A",
    "123-45 456ABCD",
    "123-45 ABCD456",
    "123-45 ABCD-456",
    "123-45 456-A",
    "197-38 269",
    "123/45 6789",
    "123.45 6789",
    "ABCD123 456-789",
    "12345 67/89",
    "ABCD123 123-45-6789",
    "ABCD123 2025-07/23",
    "ABCD123 23.07/2025",
    "ABCD123 2025-0007-00023",
    "ABCD123 0001-0002-0003",
    "ABCD123 2025-07-23Tfoo",
    "ABCD123 2025-07-23T12T34",
    "ABCD123 2025-07-23T1",
    "ABCD123 2025-07-23T123",
    "ABCD123 2025-07-23T12345",
    "ABCD123 2025-07-23T1234567",
    "ABCD123 2025-07-23T123456789",
    "AB12 345",
    "AB-12 345",
    "FR A1 123 456",
    "197 38 269",
    "78 123 456 789",
    "197\t38\t269",
    "482 731",
    "78 123",
  ] {
    let text = format!("Patient number: {value}, next field");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert_eq!(trigger_texts(&result), [value]);
  }
}

#[test]
fn company_id_trigger_accepts_closing_quote_boundaries() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  for quote in [
    '\'', '"', '‘', '’', '‚', '‛', '“', '”', '„', '‟', '«', '»', '‹', '›',
  ] {
    for suffix in ["", ", next", " confirmed"] {
      let text = format!("Patient number: ABCD123 CD456{quote}{suffix}");
      let result = prepared
        .detect_static_entities(&text)
        .expect("static detection should succeed");

      assert_eq!(trigger_texts(&result), ["ABCD123 CD456"]);
    }
  }
}

#[test]
fn company_id_trigger_accepts_immediate_prose_boundaries() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  for suffix in [
    "(active)",
    "[active]",
    "{active}",
    "\u{2010} ",
    "\u{2011},",
    "\u{2012}.",
    "\u{2013} ",
    "\u{2014}confirmed",
    "\u{2015}confirmed",
    "\u{2026}prose",
  ] {
    let text = format!("Patient number: ABCD123{suffix}");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert_eq!(trigger_texts(&result), ["ABCD123"]);
  }

  for boundary in ["_", "-", "/", "é", "Ж"] {
    let text = format!("Patient number: ABCD123{boundary}");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert!(
      result.entities.trigger().is_empty(),
      "boundary {boundary:?} must remain identifier-shaped"
    );
  }
}

#[test]
fn company_id_trigger_does_not_consume_punctuation_led_prose() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );
  let result = prepared
    .detect_static_entities("Patient number: ABCD123 .note follows")
    .expect("static detection should succeed");

  assert_eq!(trigger_texts(&result), ["ABCD123"]);
}

#[test]
fn company_id_trigger_stops_before_non_identifier_groups() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  for (value, expected) in [
    ("12345 2", "12345"),
    ("12345 67", "12345"),
    ("12345 456", "12345"),
    ("12345 6789", "12345"),
    ("12345 2025", "12345"),
    ("12345 67890", "12345"),
    ("197 38 269 2025", "197 38 269"),
    ("197 38 269 1900", "197 38 269"),
    ("197 38 269 2099", "197 38 269"),
    ("ABCD123 page2", "ABCD123"),
    ("123-45 page2", "123-45"),
    ("12345 2025-07-23", "12345"),
    ("12345 2025-07-23T12:00", "12345"),
    ("12345 23/07/2025T9:30", "12345"),
    ("12345 2025-07-23t123456", "12345"),
    ("12345 2025-07-23T12", "12345"),
    ("12345 2025-07-23T1234", "12345"),
    ("12345 2025-07-23T123456Z", "12345"),
    ("12345 2025-07-23T123456z", "12345"),
    ("12345 2025-07-23T123456.789Z", "12345"),
    ("12345 2025-07-23T123456-05:00", "12345"),
    ("12345 2025-07-23T123456-0500", "12345"),
    ("12345 2025-07-23T123456.789-05:00", "12345"),
    ("12345 2025-07-23T123456.789-0500", "12345"),
    ("12345 23/07/2025", "12345"),
    ("12345 07/23/2025", "12345"),
    ("12345 23/07/25", "12345"),
    ("12345 07/23/25", "12345"),
    ("12345 2023-02-29", "12345"),
    ("12345 2025-04-31", "12345"),
    ("12345 2025-13-01", "12345"),
    ("12345 1900-02-29", "12345"),
    ("ABCD123 2nd", "ABCD123"),
    ("12345 e.g. above", "12345"),
    ("12345 ref-code", "12345"),
    ("12345 next-field", "12345"),
    ("12345 field_name", "12345"),
    ("ABCD123 _section", "ABCD123"),
    ("AB123 CD/EF", "AB123"),
  ] {
    let text = format!("Patient number: {value}");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert_eq!(trigger_texts(&result), [expected]);
  }

  let overlong_prose = "a".repeat(129);
  let result = prepared
    .detect_static_entities(&format!("Patient number: 12345 {overlong_prose}"))
    .expect("static detection should succeed");
  assert_eq!(trigger_texts(&result), ["12345"]);
}

#[test]
fn company_id_trigger_rejects_partial_or_overlong_identifier() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );
  let overlong = format!("AB-{}", "1".repeat(129));

  for value in [
    "12345-",
    "ABCD-12345_tail",
    "ABCD123 CD456_tail",
    "ABCD123 CD-",
    "ABCD123 CD_456",
    "ABCD123 _CD456",
    "197 38 269_tail",
    "197 38 269-",
    "197 38 269_",
    "1 2025 12",
    "1 1234 12",
    "12345 67 8",
    "12345 67 8901",
    "12345 67 89_tail",
    "482 731 8",
    "AB12 345 8",
    "AB12 345 8901",
    "ABCD123 456 8",
    "ABCD123 456 8901",
    "ABCD123 456 789_tail",
    "ABCD123 4567 8",
    "ABCD123 8",
    "123-45 8",
    "123-45 6789 8",
    "ABCD123 456A 8",
    "123-45 ABCD456 _678",
    "ABCD123 456_A",
    "ABCD123 456ABCDEFGHIJKLM",
    "123-45 ABCDEFGHIJKLM456",
    "ABCD123 ABCDEFGHIJKLM-456",
    "123-45 67_tail",
    "123-45 _678",
    "FR A1 123 456 8",
    "FR A1 123 456 8901",
    "197 38 269 8",
    "197 38 269 8901",
    "197 38 269 1000",
    "197 38 269 1899",
    "197 38 269 2100",
    "197 38 269 2999",
    "ABCD123\u{2013}456",
    "ABCD123\u{2013}É456",
    "ABCD123\u{2011}٦",
    "197\u{2011}38\u{2011}269",
    "ABCD123(6)",
    "ABCD123(٦)",
    "ABCD123(É456)",
    "ABCD123(v2)",
    "ABCD123(a2)",
    "ABCD123[v2]",
    "ABCD123{a2}",
    "ABCD123[6]",
    "ABCD123{6}",
    "ABCD123\u{2014}É456",
    "ABCD123\u{2014}456",
    "ABCD123\u{2014}v2",
    "ABCD123\u{2013}confirmed",
    "ABCD123\"456",
    "ABCD123“456",
    "ABCD123“É٤56",
    "ABCD123'v2",
    overlong.as_str(),
  ] {
    let text = format!("Patient number: {value}");
    let result = prepared
      .detect_static_entities(&text)
      .expect("static detection should succeed");

    assert!(
      result.entities.trigger().is_empty(),
      "must not redact a partial prefix of {value:?}"
    );
  }

  for continuation in [
    "1".repeat(129),
    format!("{}1{}", "a".repeat(64), "a".repeat(64)),
    format!("{}-{}", "a".repeat(64), "a".repeat(64)),
  ] {
    let result = prepared
      .detect_static_entities(&format!("Patient number: 12345 {continuation}"))
      .expect("static detection should succeed");
    assert!(
      result.entities.trigger().is_empty(),
      "overlong identifier-shaped continuation must reject without a partial prefix"
    );
  }

  let structured_overlong = "1".repeat(129);
  let result = prepared
    .detect_static_entities(&format!(
      "Patient number: 123-45 {structured_overlong}"
    ))
    .expect("static detection should succeed");
  assert!(result.entities.trigger().is_empty());
}

#[test]
fn company_id_trigger_classifies_the_exact_length_boundary() {
  let prepared = prepared_for_trigger(
    "Patient number",
    "registration number",
    TriggerStrategy::CompanyIdValue,
  );

  let exact_limit = ["12"; 43].join(" ");
  assert_eq!(exact_limit.len(), 128);
  for suffix in ["", ", next", " confirmed", " follow-up", " , next"] {
    let accepted = prepared
      .detect_static_entities(&format!("Patient number: {exact_limit}{suffix}"))
      .expect("static detection should succeed");
    assert_eq!(trigger_texts(&accepted), [exact_limit.as_str()]);
  }

  for suffix in ["3", "A2", " 34", " page2", "_tail", " -tail", " (v2)"] {
    let rejected = prepared
      .detect_static_entities(&format!("Patient number: {exact_limit}{suffix}"))
      .expect("static detection should succeed");
    assert!(
      rejected.entities.trigger().is_empty(),
      "exact-limit identifier must reject overflow suffix {suffix:?}"
    );
  }

  let near_limit = ["12"; 42].join(" ");
  assert_eq!(near_limit.len(), 125);
  let accepted = prepared
    .detect_static_entities(&format!(
      "Patient number: {near_limit}   confirmed"
    ))
    .expect("static detection should succeed");
  assert_eq!(trigger_texts(&accepted), [near_limit.as_str()]);
  let rejected = prepared
    .detect_static_entities(&format!("Patient number: {near_limit}   34"))
    .expect("static detection should succeed");
  assert!(rejected.entities.trigger().is_empty());

  for value in [["12"; 44].join(" "), vec!["12"; 10_000].join(" ")] {
    let result = prepared
      .detect_static_entities(&format!("Patient number: {value}"))
      .expect("static detection should succeed");
    assert!(
      result.entities.trigger().is_empty(),
      "must reject overlong grouped identifiers without a partial prefix"
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
