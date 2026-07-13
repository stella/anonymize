#![allow(clippy::expect_used)]

use proptest::{prop_assert, proptest};
use stella_anonymize_core::{
  Error, OpenSessionArchiveOptions, REDACTION_SESSION_ARCHIVE_KEY_BYTES,
  REDACTION_SESSION_ARCHIVE_MAX_BYTES, RedactionSession, SessionArchiveKey,
  SessionId, SessionLifecycle, SessionTimestamp,
};

const VERSION_START: usize = 8;
const VERSION_END: usize = VERSION_START + size_of::<u32>();
const ALGORITHM_OFFSET: usize = VERSION_END;
const NONCE_START: usize = ALGORITHM_OFFSET + size_of::<u8>();
const CIPHERTEXT_LENGTH_START: usize = NONCE_START + 24;
const CIPHERTEXT_LENGTH_END: usize = CIPHERTEXT_LENGTH_START + size_of::<u32>();
const TEST_STATE: &str = concat!(
  r#"{"schema_version":1,"session_id":"case_1","counters":{"PERSON":1},"#,
  r#""mappings":[{"label_key":"PERSON","normalized_text":"alice","#,
  r#""placeholder":"[PERSON_case%5F1_1]","original":"Alice"}]}"#,
);

fn archive_key(byte: u8) -> SessionArchiveKey {
  SessionArchiveKey::from_bytes([byte; REDACTION_SESSION_ARCHIVE_KEY_BYTES])
}

const fn timestamp(value: u32) -> SessionTimestamp {
  SessionTimestamp::from_epoch_seconds(value)
}

#[test]
fn encrypted_archives_round_trip_without_exposing_plaintext() {
  let session = RedactionSession::from_plaintext_json(TEST_STATE)
    .expect("fixture state should be valid");
  let key = archive_key(0x42);

  let first = session
    .to_encrypted_archive(&key)
    .expect("session should encrypt");
  let second = session
    .to_encrypted_archive(&key)
    .expect("session should encrypt with a fresh nonce");

  assert_ne!(first, second, "archives must use fresh random nonces");
  assert!(
    !first
      .windows("Alice".len())
      .any(|window| window == b"Alice"),
    "archive must not expose original entity text",
  );
  let restored =
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &first,
      key: &key,
      observed_at: None,
    })
    .expect("archive should restore");
  assert_eq!(restored, session);
}

#[test]
fn wrong_keys_and_modified_authenticated_bytes_fail_generically() {
  let session = RedactionSession::from_plaintext_json(TEST_STATE)
    .expect("fixture state should be valid");
  let key = archive_key(0x42);
  let archive = session
    .to_encrypted_archive(&key)
    .expect("session should encrypt");

  let wrong_key_error =
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &archive,
      key: &archive_key(0x43),
      observed_at: None,
    })
    .expect_err("wrong key should fail");
  assert_eq!(wrong_key_error, Error::SessionArchiveAuthenticationFailed,);

  let mut modified_nonce = archive.clone();
  let nonce_byte = modified_nonce
    .get_mut(NONCE_START)
    .expect("archive should contain its nonce");
  *nonce_byte ^= 1;
  let nonce_error =
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &modified_nonce,
      key: &key,
      observed_at: None,
    })
    .expect_err("modified nonce should fail");
  assert_eq!(nonce_error, Error::SessionArchiveAuthenticationFailed);

  let mut modified_ciphertext = archive;
  let ciphertext_byte = modified_ciphertext
    .last_mut()
    .expect("archive should contain ciphertext");
  *ciphertext_byte ^= 1;
  let ciphertext_error =
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &modified_ciphertext,
      key: &key,
      observed_at: None,
    })
    .expect_err("modified ciphertext should fail");
  assert_eq!(ciphertext_error, Error::SessionArchiveAuthenticationFailed,);
}

#[test]
fn malformed_and_unsupported_archives_fail_before_decryption() {
  let session = RedactionSession::new(
    SessionId::new("case_1").expect("session id should be valid"),
  );
  let key = archive_key(0x42);
  let archive = session
    .to_encrypted_archive(&key)
    .expect("session should encrypt");

  for malformed in [
    Vec::new(),
    archive
      .get(..archive.len().saturating_sub(1))
      .expect("archive prefix should exist")
      .to_vec(),
    {
      let mut trailing = archive.clone();
      trailing.push(0);
      trailing
    },
    {
      let mut bad_length = archive.clone();
      bad_length
        .get_mut(CIPHERTEXT_LENGTH_START..CIPHERTEXT_LENGTH_END)
        .expect("archive should contain its payload length")
        .copy_from_slice(&0_u32.to_be_bytes());
      bad_length
    },
  ] {
    assert!(
      matches!(
        RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
          archive: &malformed,
          key: &key,
          observed_at: None,
        },),
        Err(Error::InvalidSessionArchive { .. })
      ),
      "malformed archive should fail structurally",
    );
  }

  let mut unsupported_version = archive.clone();
  unsupported_version
    .get_mut(VERSION_START..VERSION_END)
    .expect("archive should contain its version")
    .copy_from_slice(&2_u32.to_be_bytes());
  assert_eq!(
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &unsupported_version,
      key: &key,
      observed_at: None,
    })
    .expect_err("unsupported version should fail"),
    Error::UnsupportedSessionArchiveVersion { version: 2 },
  );

  let mut unsupported_algorithm = archive;
  *unsupported_algorithm
    .get_mut(ALGORITHM_OFFSET)
    .expect("archive should contain its algorithm") = 2;
  assert_eq!(
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &unsupported_algorithm,
      key: &key,
      observed_at: None,
    })
    .expect_err("unsupported algorithm should fail"),
    Error::UnsupportedSessionArchiveAlgorithm { algorithm: 2 },
  );
}

#[test]
fn oversized_archives_are_rejected_before_parsing() {
  let oversized = vec![0_u8; REDACTION_SESSION_ARCHIVE_MAX_BYTES + 1];

  assert!(matches!(
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &oversized,
      key: &archive_key(0x42),
      observed_at: None,
    }),
    Err(Error::InvalidSessionArchive { .. })
  ));
}

#[test]
fn lifecycle_is_enforced_when_archives_are_sealed_and_opened() {
  let lifecycle = SessionLifecycle::new(timestamp(100), Some(timestamp(200)))
    .expect("lifecycle should be valid");
  let session = RedactionSession::new_with_lifecycle(
    SessionId::new("case_1").expect("session id should be valid"),
    lifecycle,
  )
  .expect("session should initialize");
  let key = archive_key(0x42);

  assert_eq!(
    session
      .to_encrypted_archive(&key)
      .expect_err("lifecycle archive requires a time"),
    Error::SessionObservationRequired,
  );
  let archive = session
    .to_encrypted_archive_at(&key, timestamp(150))
    .expect("active lifecycle session should encrypt");

  for (observed_at, expected) in [
    (None, Error::SessionObservationRequired),
    (Some(timestamp(99)), Error::SessionNotYetActive),
    (Some(timestamp(200)), Error::SessionExpired),
  ] {
    let error =
      RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
        archive: &archive,
        key: &key,
        observed_at,
      })
      .expect_err("unavailable lifecycle archive should fail");
    assert_eq!(error, expected);
  }

  let restored =
    RedactionSession::from_encrypted_archive(OpenSessionArchiveOptions {
      archive: &archive,
      key: &key,
      observed_at: Some(timestamp(150)),
    })
    .expect("active lifecycle archive should restore");
  assert_eq!(restored, session);
}

#[test]
fn deleted_sessions_cannot_be_archived() {
  let mut session = RedactionSession::new(
    SessionId::new("case_1").expect("session id should be valid"),
  );
  session.delete().expect("session should delete");

  assert_eq!(
    session
      .to_encrypted_archive(&archive_key(0x42))
      .expect_err("deleted session should not encrypt"),
    Error::SessionDeleted,
  );
}

proptest! {
  #[test]
  fn arbitrary_non_archive_bytes_fail_without_panicking(
    tail in proptest::collection::vec(proptest::num::u8::ANY, 0..4096),
  ) {
    let mut malformed = Vec::with_capacity(tail.len().saturating_add(1));
    malformed.push(b'X');
    malformed.extend_from_slice(&tail);

    let result = RedactionSession::from_encrypted_archive(
      OpenSessionArchiveOptions {
        archive: &malformed,
        key: &archive_key(0x42),
        observed_at: None,
      },
    );
    prop_assert!(
      matches!(result, Err(Error::InvalidSessionArchive { .. })),
      "non-archive bytes must fail structurally",
    );
  }
}
