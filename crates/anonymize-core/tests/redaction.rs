#![allow(
  clippy::expect_used,
  clippy::indexing_slicing,
  clippy::panic,
  clippy::unwrap_used
)]

use stella_anonymize_core::{
  Entity, Error, OperatorConfig, OperatorType, deanonymise, redact_text,
};

fn entity(text: &str, label: &str, value: &str) -> Entity {
  let byte_start = text
    .find(value)
    .unwrap_or_else(|| panic!("missing fixture value: {value}"));
  let prefix = text
    .get(..byte_start)
    .unwrap_or_else(|| panic!("invalid fixture boundary: {byte_start}"));
  let start = utf16_len(prefix);
  let end = start.saturating_add(utf16_len(value));
  Entity::detected(start, end, label, value)
}

fn utf16_len(text: &str) -> u32 {
  u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

#[test]
fn repeated_values_share_first_non_colliding_placeholder() {
  let value = "Alice Smith";
  let text = format!("Existing [PERSON_1]. {value} called. {value} signed.");
  let first = text.find(value).unwrap_or(0);
  let second = text
    .get(first.saturating_add(1)..)
    .and_then(|tail| tail.find(value))
    .map_or(first, |relative| {
      first.saturating_add(1).saturating_add(relative)
    });
  let entities = vec![
    Entity::detected(
      u32::try_from(first).unwrap_or(u32::MAX),
      u32::try_from(first.saturating_add(value.len())).unwrap_or(u32::MAX),
      "person",
      value,
    ),
    Entity::detected(
      u32::try_from(second).unwrap_or(u32::MAX),
      u32::try_from(second.saturating_add(value.len())).unwrap_or(u32::MAX),
      "person",
      value,
    ),
  ];

  let result =
    redact_text(&text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(
    result.redacted_text,
    "Existing [PERSON_1]. [PERSON_2] called. [PERSON_2] signed."
  );
  assert_eq!(result.redaction_map[0].placeholder, "[PERSON_2]");
  assert_eq!(
    deanonymise(&result.redacted_text, &result.redaction_map),
    text
  );
}

#[test]
fn literal_placeholders_inside_extra_brackets_are_reserved() {
  let text = "Keep [[PERSON_1]]; Alice Smith signs.";
  let entities = vec![entity(text, "person", "Alice Smith")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "Keep [[PERSON_1]]; [PERSON_2] signs.");
  assert_eq!(result.redaction_map[0].placeholder, "[PERSON_2]");
}

#[test]
fn normalized_identifier_values_share_placeholder() {
  let text = "Mail Alice@Example.com and alice@example.com.";
  let entities = vec![
    entity(text, "email address", "Alice@Example.com"),
    entity(text, "email address", "alice@example.com"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[EMAIL_ADDRESS_1]");
}

#[test]
fn contextual_identifier_cues_share_identifier_placeholder() {
  let text = concat!(
    "CNI: 12AB34567 was present. ",
    "CNI nº 12AB34567 was repeated. ",
    "CNI 12AB34567 was listed."
  );
  let entities = vec![
    entity(text, "national identification number", "CNI: 12AB34567"),
    entity(text, "national identification number", "CNI nº 12AB34567"),
    entity(text, "national identification number", "CNI 12AB34567"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[NATIONAL_IDENTIFICATION_NUMBER_1]"
  );
}

#[test]
fn spaced_identifier_values_still_share_placeholder() {
  let text =
    "Card 4242 4242 4242 4242 was present. Card 4242424242424242 repeated.";
  let entities = vec![
    entity(text, "credit card number", "4242 4242 4242 4242"),
    entity(text, "credit card number", "4242424242424242"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[CREDIT_CARD_NUMBER_1]"
  );
}

#[test]
fn coreference_alias_uses_source_placeholder_and_value() {
  let text = "Acme signed. Acme Corporation countersigned.";
  let alias_start = text.find("Acme").unwrap_or(0);
  let source_start = text.find("Acme Corporation").unwrap_or(0);
  let entities = vec![
    Entity::coreference(
      u32::try_from(alias_start).unwrap_or(u32::MAX),
      u32::try_from(alias_start.saturating_add("Acme".len()))
        .unwrap_or(u32::MAX),
      "organization",
      "Acme",
      "Acme Corporation",
    ),
    Entity::detected(
      u32::try_from(source_start).unwrap_or(u32::MAX),
      u32::try_from(source_start.saturating_add("Acme Corporation".len()))
        .unwrap_or(u32::MAX),
      "organization",
      "Acme Corporation",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(
    result.redacted_text,
    "[ORGANIZATION_1] signed. [ORGANIZATION_1] countersigned."
  );
  assert_eq!(result.redaction_map[0].original, "Acme Corporation");
}

#[test]
fn same_alias_text_can_point_to_different_source_placeholders() {
  let text = "Smith met Smith.";
  let first = text.find("Smith").unwrap_or(0);
  let second = text.rfind("Smith").unwrap_or(first);
  let entities = vec![
    Entity::coreference(
      u32::try_from(first).unwrap_or(u32::MAX),
      u32::try_from(first.saturating_add("Smith".len())).unwrap_or(u32::MAX),
      "person",
      "Smith",
      "Alice Smith",
    ),
    Entity::coreference(
      u32::try_from(second).unwrap_or(u32::MAX),
      u32::try_from(second.saturating_add("Smith".len())).unwrap_or(u32::MAX),
      "person",
      "Smith",
      "Bob Smith",
    ),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "[PERSON_1] met [PERSON_2].");
  assert_eq!(result.redaction_map[0].original, "Alice Smith");
  assert_eq!(result.redaction_map[1].original, "Bob Smith");
}

#[test]
fn redact_operator_is_not_reversible() {
  let text = "Contact Alice Smith at alice@example.com.";
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("person"), OperatorType::Redact);
  config.redact_string = String::from("[GONE]");
  let entities = vec![
    entity(text, "person", "Alice Smith"),
    entity(text, "email address", "alice@example.com"),
  ];

  let result = redact_text(text, &entities, &config).unwrap();

  assert!(result.redacted_text.contains("[GONE]"));
  assert!(
    result
      .redaction_map
      .iter()
      .all(|entry| entry.placeholder != "[PERSON_1]")
  );
  assert!(
    result
      .redaction_map
      .iter()
      .any(|entry| entry.placeholder == "[EMAIL_ADDRESS_1]")
  );
}

#[test]
fn utf16_offsets_apply_non_ascii_spans() {
  let text = "A 🦀 Bob";
  let start = 5;
  let end = 8;
  let entities = vec![Entity::detected(start, end, "person", "Bob")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "A 🦀 [PERSON_1]");
}

#[test]
fn detected_original_uses_redacted_source_span() {
  let text = "Alice signed.";
  let entities = vec![Entity::detected(0, 5, "person", "Bob")];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map[0].original, "Alice");
  assert_eq!(
    deanonymise(&result.redacted_text, &result.redaction_map),
    text
  );
}

#[test]
fn invalid_utf16_boundary_is_rejected() {
  let text = "A 🦀 Bob";
  let entities = vec![Entity::detected(3, 5, "person", " Bob")];

  let error = redact_text(text, &entities, &OperatorConfig::default())
    .expect_err("offset inside a surrogate pair must fail");

  assert_eq!(error, Error::Utf16OffsetInsideSurrogate { offset: 3 });
}

#[test]
fn empty_spans_are_rejected() {
  let text = "Alice";
  let entities = vec![Entity::detected(0, 0, "person", "")];

  let error = redact_text(text, &entities, &OperatorConfig::default())
    .expect_err("empty entity spans must fail");

  assert_eq!(error, Error::InvalidSpan { start: 0, end: 0 });
}

#[test]
fn overlapping_spans_keep_first_entity() {
  let text = "Alice Smith";
  let entities = vec![
    Entity::detected(0, 11, "person", "Alice Smith"),
    Entity::detected(6, 11, "person", "Smith"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redacted_text, "[PERSON_1]");
  assert_eq!(result.entity_count, 1);
}

#[test]
fn equivalent_crypto_spellings_share_placeholders() {
  let text = concat!(
    "ETH wallet 0x742d35Cc6634C0532925a3b844Bc454e4438f44e.\n",
    "ETH wallet 0x742d35cc6634c0532925a3b844bc454e4438f44e."
  );
  let first = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  let second = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
  let entities = vec![
    entity(text, "crypto", first),
    entity(text, "crypto", second),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[CRYPTO_1]");
}

#[test]
fn equivalent_nhs_cues_share_placeholders() {
  let text = concat!(
    "NHS number 401 023 2137 was present.\n",
    "National Health Service No. 401 023 2137 was repeated."
  );
  let first = "NHS number 401 023 2137";
  let second = "National Health Service No. 401 023 2137";
  let entities = vec![
    entity(text, "national identification number", first),
    entity(text, "national identification number", second),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(
    result.redaction_map[0].placeholder,
    "[NATIONAL_IDENTIFICATION_NUMBER_1]"
  );
}

#[test]
fn equivalent_passport_cues_share_placeholders() {
  let text = concat!(
    "US passport number X12345678 was inspected.\n",
    "Passport No. X12345678 was listed."
  );
  let entities = vec![
    entity(text, "passport number", "US passport number X12345678"),
    entity(text, "passport number", "Passport No. X12345678"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 1);
  assert_eq!(result.redaction_map[0].placeholder, "[PASSPORT_NUMBER_1]");
}

#[test]
fn passport_prefixes_split_by_separators_stay_distinct() {
  let text =
    "Passport X-12345678 was inspected. Passport Y 12345678 was listed.";
  let entities = vec![
    entity(text, "passport number", "X-12345678"),
    entity(text, "passport number", "Y 12345678"),
  ];

  let result =
    redact_text(text, &entities, &OperatorConfig::default()).unwrap();

  assert_eq!(result.redaction_map.len(), 2);
  assert_eq!(result.redaction_map[0].placeholder, "[PASSPORT_NUMBER_1]");
  assert_eq!(result.redaction_map[1].placeholder, "[PASSPORT_NUMBER_2]");
}
