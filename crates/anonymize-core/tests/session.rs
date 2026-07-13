#![allow(clippy::expect_used, clippy::indexing_slicing)]

use stella_anonymize_core::{
  Entity, Error, MaskConfig, MaskDirection, Operator, OperatorConfig,
  RedactTextWithSessionParams, RedactionSession, SessionId, SessionLifecycle,
  SessionStatus, SessionTimestamp, redact_text_with_session,
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
    observed_at: None,
  })
}

const fn timestamp(value: u32) -> SessionTimestamp {
  SessionTimestamp::from_epoch_seconds(value)
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

  assert_eq!(first.redacted_text, "[PERSON_matter%5F1_1] signed.");
  assert_eq!(
    second.redacted_text,
    "[PERSON_matter%5F1_1] replied to [PERSON_matter%5F1_2]."
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

  assert_eq!(first_result.redacted_text, "[PERSON_matter%5Fa_1] signed.");
  assert_eq!(second_result.redacted_text, "[PERSON_matter%5Fb_1] signed.");
}

#[test]
fn session_placeholders_encode_label_and_namespace_boundaries() {
  let text = "Alice signed.";
  let entity_with_compound_label =
    Entity::detected(0, 5, "email address", "Alice");
  let entity_with_simple_label = Entity::detected(0, 5, "email", "Alice");
  let mut simple_namespace =
    RedactionSession::new(SessionId::new("1").expect("valid id"));
  let mut compound_namespace =
    RedactionSession::new(SessionId::new("ADDRESS_1").expect("valid id"));

  let first = redact(RedactFixtureParams {
    text,
    entities: &[entity_with_compound_label],
    config: &OperatorConfig::default(),
    session: &mut simple_namespace,
  })
  .expect("simple namespace should redact");
  let second = redact(RedactFixtureParams {
    text,
    entities: &[entity_with_simple_label],
    config: &OperatorConfig::default(),
    session: &mut compound_namespace,
  })
  .expect("compound namespace should redact");

  assert_eq!(first.redacted_text, "[EMAIL_ADDRESS_1_1] signed.");
  assert_eq!(second.redacted_text, "[EMAIL_ADDRESS%5F1_1] signed.");
  assert_ne!(first.redacted_text, second.redacted_text);
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
  assert_eq!(next.redacted_text, "[PERSON_matter%5F1_2] signed.");
}

#[test]
fn lifecycle_status_uses_caller_supplied_time_and_round_trips() {
  let lifecycle = SessionLifecycle::new(timestamp(100), Some(timestamp(200)))
    .expect("valid lifecycle");
  let session = RedactionSession::new_with_lifecycle(
    SessionId::new("matter_1").expect("valid id"),
    lifecycle,
  )
  .expect("session should initialize");

  assert_eq!(
    session.inspect(None).expect_err("time is required"),
    Error::SessionObservationRequired,
  );
  assert_eq!(
    session
      .inspect(Some(timestamp(99)))
      .expect("metadata should be available")
      .status(),
    SessionStatus::NotYetActive,
  );
  let active = session
    .inspect(Some(timestamp(100)))
    .expect("metadata should be available");
  assert_eq!(active.status(), SessionStatus::Active);
  assert_eq!(active.session_id().as_str(), "matter_1");
  assert_eq!(active.lifecycle(), Some(lifecycle));
  assert_eq!(active.mapping_count(), 0);
  assert_eq!(
    session
      .inspect(Some(timestamp(200)))
      .expect("metadata should be available")
      .status(),
    SessionStatus::Expired,
  );

  let serialized = session
    .to_plaintext_json_at(timestamp(150))
    .expect("active session should serialize");
  assert!(serialized.contains(r#""schema_version":2"#));
  assert!(serialized.contains(r#""created_at_epoch_seconds":100"#));
  assert!(serialized.contains(r#""expires_at_epoch_seconds":200"#));
  let restored = RedactionSession::from_plaintext_json(&serialized)
    .expect("lifecycle state should restore");
  assert_eq!(
    restored
      .inspect(Some(timestamp(200)))
      .expect("restored metadata should be available")
      .status(),
    SessionStatus::Expired,
  );
}

#[test]
fn lifecycle_rejects_invalid_bounds() {
  for expires_at in [99, 100] {
    let error =
      SessionLifecycle::new(timestamp(100), Some(timestamp(expires_at)))
        .expect_err("expiry must follow creation");
    assert!(matches!(error, Error::InvalidSessionState { .. }));
  }
}

#[test]
fn unavailable_sessions_fail_without_mutation() {
  let lifecycle = SessionLifecycle::new(timestamp(100), Some(timestamp(200)))
    .expect("valid lifecycle");
  let mut session = RedactionSession::new_with_lifecycle(
    SessionId::new("matter_1").expect("valid id"),
    lifecycle,
  )
  .expect("session should initialize");
  let before = session.clone();
  let text = "Alice signed.";

  for (observed_at, expected) in [
    (None, Error::SessionObservationRequired),
    (Some(timestamp(99)), Error::SessionNotYetActive),
    (Some(timestamp(200)), Error::SessionExpired),
  ] {
    let error = redact_text_with_session(RedactTextWithSessionParams {
      full_text: text,
      entities: &[person(text, "Alice")],
      config: &OperatorConfig::default(),
      session: &mut session,
      observed_at,
    })
    .expect_err("unavailable session should fail");
    assert_eq!(error, expected);
    assert_eq!(session, before);
  }

  redact_text_with_session(RedactTextWithSessionParams {
    full_text: text,
    entities: &[person(text, "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
    observed_at: Some(timestamp(150)),
  })
  .expect("active session should redact");
  assert_eq!(session.mapping_count(), 1);
}

#[test]
fn logical_deletion_clears_mappings_and_blocks_future_use() {
  let text = "Alice signed.";
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  redact(RedactFixtureParams {
    text,
    entities: &[person(text, "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect("session should redact");

  let deletion = session.delete().expect("session should delete");
  assert_eq!(deletion.session_id().as_str(), "matter_1");
  assert_eq!(deletion.deleted_mapping_count(), 1);
  let metadata = session.inspect(None).expect("deleted metadata is safe");
  assert_eq!(metadata.status(), SessionStatus::Deleted);
  assert_eq!(metadata.mapping_count(), 0);
  assert_eq!(session.to_plaintext_json(), Err(Error::SessionDeleted));
  assert_eq!(session.delete(), Err(Error::SessionDeleted));

  let error = redact(RedactFixtureParams {
    text,
    entities: &[person(text, "Alice")],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("deleted session should not redact");
  assert_eq!(error, Error::SessionDeleted);
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
  let text = "Literal [PERSON_matter%5F1_1]; Bob signed.";
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
      placeholder: String::from("[PERSON_matter%5F1_1]")
    }
  );
  assert_eq!(session, before);
}

#[test]
fn input_cannot_reserve_a_future_session_placeholder() {
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let error = redact(RedactFixtureParams {
    text: "Literal [PERSON_matter%5F1_1].",
    entities: &[],
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("session namespace collision should fail before allocation");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter%5F1_1]")
    }
  );
  assert_eq!(session.mapping_count(), 0);
}

#[test]
fn configured_redact_tokens_are_reserved_before_session_allocation() {
  let text = "Alice shared secret";
  let entities = [
    person(text, "Alice"),
    Entity::detected(13, 19, "confidential", "secret"),
  ];
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("confidential"), Operator::Redact);
  config.redact_string = String::from("[PERSON_matter%5F1_1]");
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));

  let error = redact(RedactFixtureParams {
    text,
    entities: &entities,
    config: &config,
    session: &mut session,
  })
  .expect_err("configured redact tokens must not collide with the session");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter%5F1_1]")
    }
  );
  assert_eq!(session.mapping_count(), 0);
}

#[test]
fn rendered_output_cannot_synthesize_session_placeholders() {
  let text = "[secret] Alice";
  let entities = [
    Entity::detected(1, 7, "confidential", "secret"),
    person(text, "Alice"),
  ];
  let mut config = OperatorConfig::default();
  config
    .operators
    .insert(String::from("confidential"), Operator::Redact);
  config.redact_string = String::from("PERSON_matter%5F1_1");
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let before = session.clone();

  let error = redact(RedactFixtureParams {
    text,
    entities: &entities,
    config: &config,
    session: &mut session,
  })
  .expect_err("rendered output must not synthesize session placeholders");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter%5F1_1]")
    }
  );
  assert_eq!(session, before);
}

#[test]
fn persisted_originals_cannot_contain_session_placeholders() {
  let text = "Alice met her";
  let entities = [
    person(text, "Alice"),
    Entity::coreference(10, 13, "person", "Bob", "[PERSON_matter%5F1_2]"),
  ];
  let mut session =
    RedactionSession::new(SessionId::new("matter_1").expect("valid id"));
  let before = session.clone();

  let error = redact(RedactFixtureParams {
    text,
    entities: &entities,
    config: &OperatorConfig::default(),
    session: &mut session,
  })
  .expect_err("persisted originals must not contain session placeholders");

  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter%5F1_2]")
    }
  );
  assert_eq!(session, before);
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
    r#"{"schema_version":3,"session_id":"matter_1","counters":{},"#,
    r#""mappings":[]}"#
  );
  let error = RedactionSession::from_plaintext_json(unsupported)
    .expect_err("unsupported schema version should fail");
  assert_eq!(error, Error::UnsupportedSessionVersion { version: 3 });

  let legacy = concat!(
    r#"{"schema_version":1,"session_id":"matter_1","counters":{},"#,
    r#""mappings":[]}"#
  );
  let preserved = RedactionSession::from_plaintext_json(legacy)
    .expect("schema version 1 should remain readable")
    .to_plaintext_json()
    .expect("legacy state should remain serializable");
  assert!(preserved.contains(r#""schema_version":1"#));
}

#[test]
fn imported_state_rejects_counters_below_allocated_placeholders() {
  let invalid = concat!(
    r#"{"schema_version":1,"session_id":"matter_1","counters":{"PERSON":1},"#,
    r#""mappings":[{"label_key":"PERSON","normalized_text":"alice","#,
    r#""placeholder":"[PERSON_matter%5F1_2]","original":"Alice"}]}"#,
  );

  let error = RedactionSession::from_plaintext_json(invalid)
    .expect_err("stale counters should fail validation");
  assert!(matches!(error, Error::InvalidSessionState { .. }));
}

#[test]
fn imported_state_rejects_signed_placeholder_counts() {
  let invalid = concat!(
    r#"{"schema_version":1,"session_id":"s","counters":{"PERSON":1},"#,
    r#""mappings":[{"label_key":"PERSON","normalized_text":"alice","#,
    r#""placeholder":"[PERSON_s_+1]","original":"Alice"}]}"#,
  );

  let error = RedactionSession::from_plaintext_json(invalid)
    .expect_err("placeholder counts must contain only digits");
  assert!(matches!(error, Error::InvalidSessionState { .. }));
}

#[test]
fn imported_state_rejects_placeholders_in_originals() {
  let invalid = concat!(
    r#"{"schema_version":1,"session_id":"matter_1","counters":{"PERSON":1},"#,
    r#""mappings":[{"label_key":"PERSON","normalized_text":"alice","#,
    r#""placeholder":"[PERSON_matter%5F1_1]","#,
    r#""original":"[PERSON_matter%5F1_1]"}]}"#,
  );

  let error = RedactionSession::from_plaintext_json(invalid)
    .expect_err("imported originals must not contain session placeholders");
  assert_eq!(
    error,
    Error::SessionPlaceholderCollision {
      placeholder: String::from("[PERSON_matter%5F1_1]")
    }
  );
}

#[test]
fn accepted_session_state_always_remains_transferable() {
  const VALUE_BYTES: usize = 0x0008_0000;

  let mut session =
    RedactionSession::new(SessionId::new("bounded").expect("valid id"));
  let mut reached_limit = false;
  for index in 0..32 {
    let value = format!("{index:02}{}", "x".repeat(VALUE_BYTES - 2));
    let end = u32::try_from(value.len()).expect("fixture should fit u32");
    let before = session.clone();
    let result = redact(RedactFixtureParams {
      text: &value,
      entities: &[Entity::detected(0, end, "person", &value)],
      config: &OperatorConfig::default(),
      session: &mut session,
    });
    if result.is_ok() {
      continue;
    }
    let error = result.expect_err("size limit should reject the update");
    assert!(
      matches!(error, Error::InvalidSessionState { .. }),
      "unexpected session error: {error}"
    );
    assert_eq!(session, before);
    reached_limit = true;
    break;
  }

  assert!(reached_limit, "fixture should exceed the session byte cap");
  let serialized = session
    .to_plaintext_json()
    .expect("accepted session state should serialize");
  RedactionSession::from_plaintext_json(&serialized)
    .expect("accepted session state should remain importable");
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
