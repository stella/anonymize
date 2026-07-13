#![allow(clippy::expect_used, clippy::indexing_slicing)]

use stella_anonymize_core::{
  Entity, Error, MaskConfig, MaskDirection, Operator, OperatorConfig,
  RedactTextWithSessionParams, RedactionSession, SessionId,
  redact_text_with_session,
};

use proptest::proptest;

fn person(text: &str, value: &str) -> Entity {
  let start = text.find(value).expect("fixture value should exist");
  let end = start.saturating_add(value.len());
  Entity::detected(
    u32::try_from(start).unwrap_or(u32::MAX),
    u32::try_from(end).unwrap_or(u32::MAX),
    "person",
    value,
  )
}

struct RedactFixtureParams<'a> {
  text: &'a str,
  entities: &'a [Entity],
  config: &'a OperatorConfig,
  session: &'a mut RedactionSession,
}

fn redact(
  params: RedactFixtureParams<'_>,
) -> stella_anonymize_core::Result<stella_anonymize_core::RedactionResult> {
  let RedactFixtureParams {
    text,
    entities,
    config,
    session,
  } = params;
  redact_text_with_session(RedactTextWithSessionParams {
    full_text: text,
    entities,
    config,
    session,
  })
}

#[test]
fn session_reuses_placeholders_across_documents() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let first_text = "Alice signed.";
  let first = redact(RedactFixtureParams {
    text: first_text,
    entities: &[person(first_text, "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("first redaction should succeed");
  let second_text = "Alice replied to Bob.";
  let second = redact(RedactFixtureParams {
    text: second_text,
    entities: &[person(second_text, "Alice"), person(second_text, "Bob")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("second redaction should succeed");

  assert_eq!(first.redacted_text, "[PERSON_matter_1_1] signed.");
  assert_eq!(
    second.redacted_text,
    "[PERSON_matter_1_1] replied to [PERSON_matter_1_2]."
  );
  assert_eq!(session.mapping_count(), 2);
}

#[test]
fn session_namespaces_are_isolated() {
  let text = "Alice signed.";
  let entities = [person(text, "Alice")];
  let mut first =
    RedactionSession::new(SessionId::new("matter_a").expect("valid id"));
  let mut second =
    RedactionSession::new(SessionId::new("matter_b").expect("valid id"));

  let first_result = redact(RedactFixtureParams {
    text,
    entities: &entities,
    config: &OperatorConfig::default(),
    session: &mut first,
  })
  .expect("first session should redact");
  let second_result = redact(RedactFixtureParams {
    text,
    entities: &entities,
    config: &OperatorConfig::default(),
    session: &mut second,
  })
  .expect("second session should redact");

  assert_eq!(first_result.redacted_text, "[PERSON_matter_a_1] signed.");
  assert_eq!(second_result.redacted_text, "[PERSON_matter_b_1] signed.");
}

#[test]
fn plaintext_state_round_trips_deterministically_and_continues_counters() {
  let text = "Alice signed.";
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  redact(RedactFixtureParams {
    text,
    entities: &[person(text, "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("redaction should succeed");

  let first = session
    .to_plaintext_json()
    .expect("serialization should succeed");
  let second = session
    .to_plaintext_json()
    .expect("serialization should be repeatable");
  let mut restored = RedactionSession::from_plaintext_json(&first)
    .expect("serialized state should restore");
  assert_eq!(first, second);
  assert_eq!(restored, session);

  let next_text = "Bob signed.";
  let next = redact(RedactFixtureParams {
    text: next_text,
    entities: &[person(next_text, "Bob")],
    config: &OperatorConfig::default(),
    session: &mut restored,
  })
  .expect("restored session should continue");
  assert_eq!(next.redacted_text, "[PERSON_matter_1_2] signed.");
}

#[test]
fn session_keeps_the_first_canonical_original() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  redact(RedactFixtureParams {
    text: "Alice signed.",
    entities: &[Entity::detected(0, 5, "person", "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("first redaction should succeed");

  let result = redact(RedactFixtureParams {
    text: "ALICE replied.",
    entities: &[Entity::detected(0, 5, "person", "ALICE")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("second redaction should succeed");

  assert_eq!(result.redaction_map[0].original, "Alice");
}

#[test]
fn failed_redaction_does_not_mutate_the_session() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let before = session.clone();
  let error = redact(RedactFixtureParams {
    text: "🦀",
    entities: &[Entity::detected(1, 2, "person", "🦀")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("mid-codepoint offsets should fail");

  assert_eq!(error, Error::ByteOffsetInsideCodepoint { offset: 1 });
  assert_eq!(session, before);
}

#[test]
fn input_cannot_reuse_an_allocated_session_placeholder() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  redact(RedactFixtureParams {
    text: "Alice signed.",
    entities: &[Entity::detected(0, 5, "person", "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("initial redaction should succeed");
  let before = session.clone();
  let text = "Literal [PERSON_matter_1_1]; Bob signed.";
  let error = redact(RedactFixtureParams {
    text,
    entities: &[person(text, "Bob")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("reserved session placeholder should fail");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter_1_1]")
    }
  );
  assert_eq!(session, before);
}

#[test]
fn input_cannot_reserve_a_future_session_placeholder() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let error = redact(RedactFixtureParams {
    text: "Literal [PERSON_matter_1_1].",
    entities: &[],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("session namespace collision should fail before allocation");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter_1_1]")
    }
  );
  assert_eq!(session.mapping_count(), 0);
}

#[test]
fn irreversible_operators_do_not_persist_session_mappings() {
  let text = "Alice signed.";
  let operators = [
    Operator::Redact,
    Operator::Keep,
    Operator::Mask(
      MaskConfig::new("*", 2, MaskDirection::End)
        .expect("valid mask configuration"),
    ),
  ];

  for (index, operator) in operators.into_iter().enumerate() {
    let mut config = OperatorConfig::default();
    config.operators.insert(String::from("person"), operator);
    let mut session = RedactionSession::new(
      SessionId::new(format!("matter_{index}")).expect("valid id"),
    );
    redact(RedactFixtureParams {
      text,
      entities: &[person(text, "Alice")],
      config: &config,
      session: &mut session,
    })
    .expect("redaction should succeed");

    assert_eq!(session.mapping_count(), 0);
  }
}

#[test]
fn transient_operators_do_not_apply_persistence_value_limits() {
  const OVERSIZED_VALUE_BYTES: usize = 0x0010_0001;

  let oversized = "x".repeat(OVERSIZED_VALUE_BYTES);
  let oversized_end =
    u32::try_from(oversized.len()).expect("fixture should fit u32");
  let mut redact_config = OperatorConfig::default();
  redact_config
    .operators
    .insert(String::from("person"), Operator::Redact);
  let mut session =
    RedactionSession::new(SessionId::new("large_value").expect("valid id"));
  redact(RedactFixtureParams {
    text: &oversized,
    entities: &[Entity::detected(0, oversized_end, "person", &oversized)],
    config: &redact_config,
    session: &mut session,
  })
  .expect("transient oversized values should redact");

  let mut keep_config = OperatorConfig::default();
  keep_config
    .operators
    .insert(String::from("person"), Operator::Keep);
  redact(RedactFixtureParams {
    text: "A",
    entities: &[Entity::detected(0, 1, "person", " ")],
    config: &keep_config,
    session: &mut session,
  })
  .expect("transient empty normalized values should be kept");

  assert_eq!(session.mapping_count(), 0);
}

#[test]
fn session_ids_and_schema_versions_are_validated() {
  for invalid in ["", "contains space", "contains[bracket]"] {
    assert!(SessionId::new(invalid).is_err());
  }
  let unsupported = concat!(
    r#"{"schema_version":2,"session_id":"matter_1","counters":{},"#,
    r#""mappings":[]}"#
  );
  let error = RedactionSession::from_plaintext_json(unsupported)
    .expect_err("unsupported schema version should fail");
  assert_eq!(error, Error::UnsupportedSessionVersion { version: 2 });
}

#[test]
fn imported_state_rejects_counters_below_allocated_placeholders() {
  let invalid = concat!(
    r#"{"schema_version":1,"session_id":"matter_1","counters":{"PERSON":1},"#,
    r#""mappings":[{"label_key":"PERSON","normalized_text":"alice","#,
    r#""placeholder":"[PERSON_matter_1_2]","original":"Alice"}]}"#,
  );

  let error = RedactionSession::from_plaintext_json(invalid)
    .expect_err("stale counters should fail validation");
  assert!(matches!(error, Error::InvalidSessionState { .. }));
}

proptest! {
  #[test]
  fn plaintext_state_round_trip_is_byte_stable(
    values in proptest::collection::vec(
      proptest::string::string_regex("[a-z]{1,16}")
        .expect("test strategy should compile"),
      1..32,
    ),
  ) {
    let mut session = RedactionSession::new(
      SessionId::new("property_session").expect("valid id"),
    );
    for value in values {
      let end = u32::try_from(value.len()).unwrap_or(u32::MAX);
      redact(RedactFixtureParams {
        text: &value,
        entities: &[Entity::detected(0, end, "person", &value)],
        config: &OperatorConfig::default(),
        session: &mut session,
      })
      .expect("generated redaction should succeed");
    }

    let serialized = session
      .to_plaintext_json()
      .expect("generated session should serialize");
    let restored = RedactionSession::from_plaintext_json(&serialized)
      .expect("generated session should restore");
    assert_eq!(
      restored
        .to_plaintext_json()
        .expect("restored session should serialize"),
      serialized,
    );
  }
}
