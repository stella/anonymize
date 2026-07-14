use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::placeholders::{
  PlaceholderIdentity, collect_placeholder_counts,
  collect_reserved_placeholders, placeholder_identity,
  reserved_placeholder_spans,
};
use crate::types::{Entity, Error, PlaceholderMap, RedactionEntry, Result};

/// Current schema version for plaintext redaction-session transfer.
pub const REDACTION_SESSION_SCHEMA_VERSION: u32 = 2;

const MAX_SESSION_ID_BYTES: usize = 64;
const MAX_SESSION_MAPPINGS: usize = 100_000;
pub(crate) const MAX_SESSION_STATE_BYTES: usize = 0x0100_0000;
const MAX_SESSION_VALUE_BYTES: usize = 0x0010_0000;
const MAX_SESSION_RESTORE_TEXT_BYTES: usize = 0x0100_0000;
const MAX_PLACEHOLDER_COMPONENT_BYTES: usize = 128;
const EMPTY_SESSION_STATE_TEMPLATE: &str =
  r#"{"schema_version":1,"session_id":"","counters":{},"mappings":[]}"#;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
/// Whole seconds since 1970-01-01T00:00:00Z.
///
/// The core never reads a process clock. Callers provide timestamps so expiry
/// behavior remains deterministic and testable across runtimes.
pub struct SessionTimestamp(u32);

impl SessionTimestamp {
  #[must_use]
  pub const fn from_epoch_seconds(value: u32) -> Self {
    Self(value)
  }

  #[must_use]
  pub const fn epoch_seconds(self) -> u32 {
    self.0
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
/// Immutable lifecycle bounds for a redaction session.
pub struct SessionLifecycle {
  created_at: SessionTimestamp,
  expires_at: Option<SessionTimestamp>,
}

impl SessionLifecycle {
  pub fn new(
    created_at: SessionTimestamp,
    expires_at: Option<SessionTimestamp>,
  ) -> Result<Self> {
    if expires_at.is_some_and(|expires_at| expires_at <= created_at) {
      return Err(invalid_session_state(
        "session expiry must be later than its creation time",
      ));
    }
    Ok(Self {
      created_at,
      expires_at,
    })
  }

  #[must_use]
  pub const fn created_at(&self) -> SessionTimestamp {
    self.created_at
  }

  #[must_use]
  pub const fn expires_at(&self) -> Option<SessionTimestamp> {
    self.expires_at
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
/// Availability observed at a caller-supplied time.
pub enum SessionStatus {
  Active,
  NotYetActive,
  Expired,
  Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
/// Inspection-safe session state that contains no entity values.
pub struct SessionMetadata {
  session_id: SessionId,
  lifecycle: Option<SessionLifecycle>,
  mapping_count: usize,
  status: SessionStatus,
}

impl SessionMetadata {
  #[must_use]
  pub const fn session_id(&self) -> &SessionId {
    &self.session_id
  }

  #[must_use]
  pub const fn lifecycle(&self) -> Option<SessionLifecycle> {
    self.lifecycle
  }

  #[must_use]
  pub const fn mapping_count(&self) -> usize {
    self.mapping_count
  }

  #[must_use]
  pub const fn status(&self) -> SessionStatus {
    self.status
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
/// Audit-safe result of logical session deletion.
pub struct SessionDeletionSummary {
  session_id: SessionId,
  deleted_mapping_count: usize,
}

impl SessionDeletionSummary {
  #[must_use]
  pub const fn session_id(&self) -> &SessionId {
    &self.session_id
  }

  #[must_use]
  pub const fn deleted_mapping_count(&self) -> usize {
    self.deleted_mapping_count
  }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
/// Opaque, non-sensitive namespace embedded in session placeholders.
///
/// Session identifiers are visible in redacted output and must not contain a
/// customer name, matter title, or other sensitive value.
pub struct SessionId(String);

impl SessionId {
  pub fn new(value: impl Into<String>) -> Result<Self> {
    let value = value.into();
    validate_session_id(&value)?;
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }

  fn validate_reserved_text(&self, text: &str) -> Result<()> {
    self.validate_reserved_placeholders(&collect_reserved_placeholders(text))
  }

  fn validate_reserved_placeholders(
    &self,
    reserved: &BTreeSet<String>,
  ) -> Result<()> {
    let collision = reserved
      .iter()
      .find(|placeholder| self.owns_placeholder(placeholder));
    let Some(placeholder) = collision else {
      return Ok(());
    };
    Err(Error::SessionPlaceholderCollision {
      placeholder: placeholder.clone(),
    })
  }

  fn owns_placeholder(&self, placeholder: &str) -> bool {
    let encoded_namespace = encode_session_namespace(self.as_str());
    placeholder
      .strip_prefix('[')
      .and_then(|value| value.strip_suffix(']'))
      .and_then(|value| value.rsplit_once('_'))
      .and_then(|(prefix, _)| prefix.rsplit_once('_'))
      .is_some_and(|(label_key, namespace)| {
        !label_key.is_empty() && namespace == encoded_namespace
      })
  }
}

/// In-memory cross-document placeholder state.
///
/// Serialized state contains plaintext personal data. It is intended only for
/// deterministic in-memory transfer until an encrypted persistence contract is
/// available.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionSession {
  id: SessionId,
  lifecycle: Option<SessionLifecycle>,
  deleted: bool,
  counters: BTreeMap<String, u32>,
  placeholders: BTreeMap<PlaceholderIdentity, String>,
  originals: BTreeMap<String, String>,
  serialized_len: usize,
}

pub(crate) struct SessionPlaceholderInput<'a> {
  pub(crate) entity: &'a Entity,
  pub(crate) original: &'a str,
  pub(crate) persist: bool,
}

pub(crate) struct SessionPlaceholderPlan {
  pub(crate) placeholder_map: PlaceholderMap,
  pub(crate) update: SessionUpdate,
}

pub(crate) struct SessionUpdate {
  counter_updates: BTreeMap<String, u32>,
  new_mappings: Vec<(PlaceholderIdentity, String, String)>,
  serialized_len: usize,
}

impl RedactionSession {
  #[must_use]
  pub const fn new(id: SessionId) -> Self {
    let serialized_len = EMPTY_SESSION_STATE_TEMPLATE
      .len()
      .saturating_add(id.0.len());
    Self {
      id,
      lifecycle: None,
      deleted: false,
      counters: BTreeMap::new(),
      placeholders: BTreeMap::new(),
      originals: BTreeMap::new(),
      serialized_len,
    }
  }

  pub fn new_with_lifecycle(
    id: SessionId,
    lifecycle: SessionLifecycle,
  ) -> Result<Self> {
    let mut session = Self {
      id,
      lifecycle: Some(lifecycle),
      deleted: false,
      counters: BTreeMap::new(),
      placeholders: BTreeMap::new(),
      originals: BTreeMap::new(),
      serialized_len: 0,
    };
    session.serialized_len = session.serialize_plaintext_json()?.len();
    Ok(session)
  }

  #[must_use]
  pub const fn id(&self) -> &SessionId {
    &self.id
  }

  #[must_use]
  pub fn mapping_count(&self) -> usize {
    self.placeholders.len()
  }

  pub fn inspect(
    &self,
    observed_at: Option<SessionTimestamp>,
  ) -> Result<SessionMetadata> {
    Ok(SessionMetadata {
      session_id: self.id.clone(),
      lifecycle: self.lifecycle,
      mapping_count: self.mapping_count(),
      status: self.status(observed_at)?,
    })
  }

  /// Clears mappings and permanently blocks future use of this instance.
  ///
  /// This is logical deletion. It does not revoke earlier clones or serialized
  /// copies, and does not guarantee physical erasure of allocator or process
  /// memory.
  pub fn delete(&mut self) -> Result<SessionDeletionSummary> {
    if self.deleted {
      return Err(Error::SessionDeleted);
    }
    let deleted_mapping_count = self.mapping_count();
    self.counters.clear();
    self.placeholders.clear();
    self.originals.clear();
    self.serialized_len = 0;
    self.deleted = true;
    Ok(SessionDeletionSummary {
      session_id: self.id.clone(),
      deleted_mapping_count,
    })
  }

  /// Serializes plaintext session state deterministically.
  ///
  /// The returned JSON contains original and normalized entity values. It must
  /// not be logged or persisted without an application-owned protection layer.
  pub fn to_plaintext_json(&self) -> Result<String> {
    self.ensure_active(None)?;
    self.to_plaintext_json_unchecked()
  }

  pub fn to_plaintext_json_at(
    &self,
    observed_at: SessionTimestamp,
  ) -> Result<String> {
    self.ensure_active(Some(observed_at))?;
    self.to_plaintext_json_unchecked()
  }

  /// Restores this session's complete placeholders in one non-cascading pass.
  /// Unknown placeholders owned by the session fail closed.
  pub fn restore_text(
    &self,
    text: &str,
    observed_at: Option<SessionTimestamp>,
  ) -> Result<String> {
    self.ensure_active(observed_at)?;
    if text.len() > MAX_SESSION_RESTORE_TEXT_BYTES {
      return Err(Error::SessionRestoration {
        reason: String::from("input exceeds the maximum byte length"),
      });
    }
    let mut restored = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in reserved_placeholder_spans(text) {
      let Some(placeholder) = text.get(start..end) else {
        return Err(Error::SessionRestoration {
          reason: String::from("placeholder span is invalid"),
        });
      };
      if !self.id.owns_placeholder(placeholder) {
        continue;
      }
      let Some(original) = self.originals.get(placeholder) else {
        return Err(Error::SessionRestoration {
          reason: String::from("text contains an unknown session placeholder"),
        });
      };
      let unchanged_bytes =
        start
          .checked_sub(cursor)
          .ok_or_else(|| Error::SessionRestoration {
            reason: String::from("placeholder spans are not ordered"),
          })?;
      let projected_len = restored
        .len()
        .checked_add(unchanged_bytes)
        .and_then(|length| length.checked_add(original.len()))
        .ok_or_else(|| Error::SessionRestoration {
          reason: String::from("output byte length overflowed"),
        })?;
      if projected_len > MAX_SESSION_RESTORE_TEXT_BYTES {
        return Err(Error::SessionRestoration {
          reason: String::from("output exceeds the maximum byte length"),
        });
      }
      let unchanged =
        text
          .get(cursor..start)
          .ok_or_else(|| Error::SessionRestoration {
            reason: String::from("unchanged text span is invalid"),
          })?;
      restored.push_str(unchanged);
      restored.push_str(original);
      cursor = end;
    }
    let tail_bytes = text.len().checked_sub(cursor).ok_or_else(|| {
      Error::SessionRestoration {
        reason: String::from("restoration cursor exceeds the input length"),
      }
    })?;
    let final_len =
      restored.len().checked_add(tail_bytes).ok_or_else(|| {
        Error::SessionRestoration {
          reason: String::from("output byte length overflowed"),
        }
      })?;
    if final_len > MAX_SESSION_RESTORE_TEXT_BYTES {
      return Err(Error::SessionRestoration {
        reason: String::from("output exceeds the maximum byte length"),
      });
    }
    let tail = text
      .get(cursor..)
      .ok_or_else(|| Error::SessionRestoration {
        reason: String::from("restoration tail span is invalid"),
      })?;
    restored.push_str(tail);
    Ok(restored)
  }

  fn to_plaintext_json_unchecked(&self) -> Result<String> {
    let serialized = self.serialize_plaintext_json()?;
    if serialized.len() > MAX_SESSION_STATE_BYTES {
      return Err(Error::SessionSerialization {
        reason: String::from(
          "serialized session state exceeds the maximum byte length",
        ),
      });
    }
    if serialized.len() != self.serialized_len {
      return Err(Error::SessionSerialization {
        reason: String::from("session size metadata is inconsistent"),
      });
    }
    Ok(serialized)
  }

  fn serialize_plaintext_json(&self) -> Result<String> {
    let mut mappings = Vec::with_capacity(self.placeholders.len());
    for (identity, placeholder) in &self.placeholders {
      let Some(original) = self.originals.get(placeholder) else {
        return Err(Error::SessionSerialization {
          reason: String::from(
            "session placeholder is missing its original value",
          ),
        });
      };
      mappings.push(SessionMappingRef {
        label_key: &identity.label_key,
        normalized_text: &identity.text,
        placeholder,
        original,
      });
    }
    let envelope = SessionEnvelopeRef {
      schema_version: if self.lifecycle.is_some() {
        REDACTION_SESSION_SCHEMA_VERSION
      } else {
        1
      },
      session_id: self.id.as_str(),
      lifecycle: self.lifecycle.map(SessionLifecycleRef::from),
      counters: &self.counters,
      mappings,
    };
    serde_json::to_string(&envelope).map_err(|error| {
      Error::SessionSerialization {
        reason: error.to_string(),
      }
    })
  }

  /// Restores validated plaintext session state.
  ///
  /// The input contains personal data and is size-limited before parsing. This
  /// is not a durable or encrypted archive format.
  pub fn from_plaintext_json(value: &str) -> Result<Self> {
    if value.len() > MAX_SESSION_STATE_BYTES {
      return Err(invalid_session_state(
        "session state exceeds the maximum byte length",
      ));
    }
    let envelope =
      serde_json::from_str::<SessionEnvelope>(value).map_err(|error| {
        invalid_session_state(format!("invalid JSON: {error}"))
      })?;
    if !matches!(
      envelope.schema_version,
      1 | REDACTION_SESSION_SCHEMA_VERSION
    ) {
      return Err(Error::UnsupportedSessionVersion {
        version: envelope.schema_version,
      });
    }
    if envelope.schema_version == 1 && envelope.lifecycle.is_some() {
      return Err(invalid_session_state(
        "schema version 1 must not contain lifecycle metadata",
      ));
    }
    if envelope.mappings.len() > MAX_SESSION_MAPPINGS {
      return Err(invalid_session_state(
        "session state contains too many mappings",
      ));
    }

    let id = SessionId::new(envelope.session_id)?;
    let lifecycle = envelope
      .lifecycle
      .map(SessionLifecycle::try_from)
      .transpose()?;
    validate_counters(&envelope.counters)?;
    let mut placeholders = BTreeMap::new();
    let mut originals = BTreeMap::new();
    let mut maximum_counts = BTreeMap::<String, u32>::new();
    for mapping in envelope.mappings {
      validate_placeholder_component("label_key", &mapping.label_key)?;
      validate_mapping_value("normalized_text", &mapping.normalized_text)?;
      validate_mapping_value("original", &mapping.original)?;
      id.validate_reserved_text(&mapping.original)?;
      let count = session_placeholder_count(SessionPlaceholderParams {
        placeholder: &mapping.placeholder,
        label_key: &mapping.label_key,
        session_id: id.as_str(),
      })?;
      if originals
        .insert(mapping.placeholder.clone(), mapping.original)
        .is_some()
      {
        return Err(invalid_session_state(
          "session state contains a duplicate placeholder",
        ));
      }
      let identity = PlaceholderIdentity {
        label_key: mapping.label_key.clone(),
        text: mapping.normalized_text,
      };
      if placeholders.insert(identity, mapping.placeholder).is_some() {
        return Err(invalid_session_state(
          "session state contains a duplicate entity identity",
        ));
      }
      maximum_counts
        .entry(mapping.label_key)
        .and_modify(|maximum| *maximum = (*maximum).max(count))
        .or_insert(count);
    }
    for (label_key, maximum) in maximum_counts {
      let counter = envelope.counters.get(&label_key).copied().unwrap_or(0);
      if counter < maximum {
        return Err(invalid_session_state(
          "session counter is lower than an allocated placeholder",
        ));
      }
    }

    let mut session = Self {
      id,
      lifecycle,
      deleted: false,
      counters: envelope.counters,
      placeholders,
      originals,
      serialized_len: 0,
    };
    let serialized_len = session.serialize_plaintext_json()?.len();
    if serialized_len > MAX_SESSION_STATE_BYTES {
      return Err(invalid_session_state(
        "session state exceeds the maximum serialized byte length",
      ));
    }
    session.serialized_len = serialized_len;
    Ok(session)
  }

  pub(crate) fn plan_placeholder_map(
    &self,
    inputs: &[SessionPlaceholderInput<'_>],
    reserved_sources: &[&str],
  ) -> Result<SessionPlaceholderPlan> {
    let mut reserved = BTreeSet::new();
    for source in reserved_sources {
      reserved.append(&mut collect_reserved_placeholders(source));
    }
    self.id.validate_reserved_placeholders(&reserved)?;
    let mut occupied = reserved;

    let mut transient_counters = BTreeMap::<String, u32>::new();
    let mut transient_mappings = BTreeMap::<PlaceholderIdentity, String>::new();
    let mut counter_updates = BTreeMap::<String, u32>::new();
    let mut new_placeholders = BTreeMap::<PlaceholderIdentity, String>::new();
    let mut new_mappings = Vec::new();
    let mut placeholder_map = PlaceholderMap::default();
    for input in inputs {
      if placeholder_map.has_entity(input.entity) {
        continue;
      }
      let identity = placeholder_identity(input.entity);

      if input.persist {
        validate_placeholder_component("label_key", &identity.label_key)?;
        validate_mapping_value("normalized_text", &identity.text)?;
        if let Some(placeholder) = self.placeholders.get(&identity) {
          placeholder_map.push_entity(input.entity, placeholder);
          continue;
        }
        if let Some(placeholder) = new_placeholders.get(&identity) {
          placeholder_map.push_entity(input.entity, placeholder);
          continue;
        }
        if self.placeholders.len().saturating_add(new_mappings.len())
          >= MAX_SESSION_MAPPINGS
        {
          return Err(invalid_session_state(
            "session contains too many mappings",
          ));
        }
        validate_mapping_value("original", input.original)?;
        self.id.validate_reserved_text(input.original)?;
        let count = counter_updates
          .get(&identity.label_key)
          .or_else(|| self.counters.get(&identity.label_key))
          .copied()
          .unwrap_or(0);
        let (placeholder, count) = next_placeholder(NextPlaceholderOptions {
          label_key: &identity.label_key,
          namespace: Some(self.id.as_str()),
          count,
          existing_occupied: &self.originals,
          occupied: &mut occupied,
        })?;
        placeholder_map.push_entity(input.entity, &placeholder);
        counter_updates.insert(identity.label_key.clone(), count);
        new_placeholders.insert(identity.clone(), placeholder.clone());
        new_mappings.push((identity, placeholder, input.original.to_owned()));
        continue;
      }

      if let Some(placeholder) = transient_mappings.get(&identity) {
        placeholder_map.push_entity(input.entity, placeholder);
        continue;
      }
      let count = transient_counters
        .get(&identity.label_key)
        .copied()
        .unwrap_or(0);
      let (placeholder, count) = next_placeholder(NextPlaceholderOptions {
        label_key: &identity.label_key,
        namespace: None,
        count,
        existing_occupied: &self.originals,
        occupied: &mut occupied,
      })?;
      placeholder_map.push_entity(input.entity, &placeholder);
      transient_counters.insert(identity.label_key.clone(), count);
      transient_mappings.insert(identity, placeholder);
    }
    let serialized_len =
      self.projected_serialized_len(&counter_updates, &new_mappings)?;
    Ok(SessionPlaceholderPlan {
      placeholder_map,
      update: SessionUpdate {
        counter_updates,
        new_mappings,
        serialized_len,
      },
    })
  }

  pub(crate) fn apply_update(&mut self, update: SessionUpdate) {
    for (label_key, count) in update.counter_updates {
      self.counters.insert(label_key, count);
    }
    for (identity, placeholder, original) in update.new_mappings {
      self.originals.insert(placeholder.clone(), original);
      self.placeholders.insert(identity, placeholder);
    }
    self.serialized_len = update.serialized_len;
  }

  pub(crate) fn validate_reserved_text(&self, text: &str) -> Result<()> {
    self.id.validate_reserved_text(text)
  }

  pub(crate) fn ensure_active(
    &self,
    observed_at: Option<SessionTimestamp>,
  ) -> Result<()> {
    match self.status(observed_at)? {
      SessionStatus::Active => Ok(()),
      SessionStatus::NotYetActive => Err(Error::SessionNotYetActive),
      SessionStatus::Expired => Err(Error::SessionExpired),
      SessionStatus::Deleted => Err(Error::SessionDeleted),
    }
  }

  fn status(
    &self,
    observed_at: Option<SessionTimestamp>,
  ) -> Result<SessionStatus> {
    if self.deleted {
      return Ok(SessionStatus::Deleted);
    }
    let Some(lifecycle) = self.lifecycle else {
      return Ok(SessionStatus::Active);
    };
    let Some(observed_at) = observed_at else {
      return Err(Error::SessionObservationRequired);
    };
    if observed_at < lifecycle.created_at {
      return Ok(SessionStatus::NotYetActive);
    }
    if lifecycle
      .expires_at
      .is_some_and(|expires_at| observed_at >= expires_at)
    {
      return Ok(SessionStatus::Expired);
    }
    Ok(SessionStatus::Active)
  }

  pub(crate) fn validate_rendered_placeholders(
    &self,
    text: &str,
    expected: &BTreeMap<String, usize>,
  ) -> Result<()> {
    let actual = collect_placeholder_counts(text);
    let unexpected = actual.iter().find(|(placeholder, count)| {
      self.id.owns_placeholder(placeholder)
        && expected.get(*placeholder) != Some(*count)
    });
    if let Some((placeholder, _)) = unexpected {
      return Err(Error::SessionPlaceholderCollision {
        placeholder: placeholder.clone(),
      });
    }
    let missing = expected.iter().find(|(placeholder, count)| {
      self.id.owns_placeholder(placeholder)
        && actual.get(*placeholder) != Some(*count)
    });
    let Some((placeholder, _)) = missing else {
      return Ok(());
    };
    Err(Error::SessionPlaceholderCollision {
      placeholder: placeholder.clone(),
    })
  }

  pub(crate) fn canonicalize_redaction_map(
    &self,
    redaction_map: &mut [RedactionEntry],
  ) {
    for entry in redaction_map {
      let Some(original) = self.originals.get(&entry.placeholder) else {
        continue;
      };
      entry.original.clear();
      entry.original.push_str(original);
    }
  }

  fn projected_serialized_len(
    &self,
    counter_updates: &BTreeMap<String, u32>,
    new_mappings: &[(PlaceholderIdentity, String, String)],
  ) -> Result<usize> {
    let mut projected = self.serialized_len;
    let mut counter_count = self.counters.len();
    for (label_key, count) in counter_updates {
      if let Some(previous) = self.counters.get(label_key) {
        projected = projected
          .checked_sub(previous.to_string().len())
          .and_then(|value| value.checked_add(count.to_string().len()))
          .ok_or_else(session_size_overflow)?;
        continue;
      }
      let serialized_label =
        serde_json::to_string(label_key).map_err(|error| {
          Error::SessionSerialization {
            reason: error.to_string(),
          }
        })?;
      let separator_bytes = usize::from(counter_count > 0);
      let entry_bytes = serialized_label
        .len()
        .checked_add(1)
        .and_then(|value| value.checked_add(count.to_string().len()))
        .and_then(|value| value.checked_add(separator_bytes))
        .ok_or_else(session_size_overflow)?;
      projected = projected
        .checked_add(entry_bytes)
        .ok_or_else(session_size_overflow)?;
      counter_count = counter_count
        .checked_add(1)
        .ok_or_else(session_size_overflow)?;
    }

    let mut mapping_count = self.placeholders.len();
    for (identity, placeholder, original) in new_mappings {
      let serialized = serde_json::to_string(&SessionMappingRef {
        label_key: &identity.label_key,
        normalized_text: &identity.text,
        placeholder,
        original,
      })
      .map_err(|error| Error::SessionSerialization {
        reason: error.to_string(),
      })?;
      let separator_bytes = usize::from(mapping_count > 0);
      projected = projected
        .checked_add(serialized.len())
        .and_then(|value| value.checked_add(separator_bytes))
        .ok_or_else(session_size_overflow)?;
      mapping_count = mapping_count
        .checked_add(1)
        .ok_or_else(session_size_overflow)?;
    }
    if projected > MAX_SESSION_STATE_BYTES {
      return Err(invalid_session_state(
        "session state exceeds the maximum serialized byte length",
      ));
    }
    Ok(projected)
  }
}

struct NextPlaceholderOptions<'a> {
  label_key: &'a str,
  namespace: Option<&'a str>,
  count: u32,
  existing_occupied: &'a BTreeMap<String, String>,
  occupied: &'a mut BTreeSet<String>,
}

fn next_placeholder(
  options: NextPlaceholderOptions<'_>,
) -> Result<(String, u32)> {
  let NextPlaceholderOptions {
    label_key,
    namespace,
    mut count,
    existing_occupied,
    occupied,
  } = options;
  loop {
    count =
      count
        .checked_add(1)
        .ok_or_else(|| Error::SessionCounterExhausted {
          label: label_key.to_owned(),
        })?;
    let placeholder = namespace.map_or_else(
      || format!("[{label_key}_{count}]"),
      |namespace| {
        let encoded_namespace = encode_session_namespace(namespace);
        format!("[{label_key}_{encoded_namespace}_{count}]")
      },
    );
    if !existing_occupied.contains_key(&placeholder)
      && occupied.insert(placeholder.clone())
    {
      return Ok((placeholder, count));
    }
  }
}

fn validate_session_id(value: &str) -> Result<()> {
  if value.is_empty() {
    return Err(Error::InvalidSessionId {
      reason: String::from("session id must not be empty"),
    });
  }
  if value.len() > MAX_SESSION_ID_BYTES {
    return Err(Error::InvalidSessionId {
      reason: format!(
        "session id must not exceed {MAX_SESSION_ID_BYTES} ASCII bytes"
      ),
    });
  }
  if !value.chars().all(|character| {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
  }) {
    return Err(Error::InvalidSessionId {
      reason: String::from(
        "session id must contain only ASCII letters, digits, hyphens, or underscores",
      ),
    });
  }
  Ok(())
}

fn encode_session_namespace(value: &str) -> String {
  value.replace('_', "%5F")
}

fn validate_counters(counters: &BTreeMap<String, u32>) -> Result<()> {
  for (label_key, counter) in counters {
    validate_placeholder_component("counter label", label_key)?;
    if *counter == 0 {
      return Err(invalid_session_state(
        "session counters must be greater than zero",
      ));
    }
  }
  Ok(())
}

fn validate_placeholder_component(
  field: &'static str,
  value: &str,
) -> Result<()> {
  if value.is_empty()
    || value.len() > MAX_PLACEHOLDER_COMPONENT_BYTES
    || value.chars().any(|character| {
      character.is_whitespace() || matches!(character, '[' | ']')
    })
  {
    return Err(invalid_session_state(format!(
      "{field} is not a valid placeholder component"
    )));
  }
  Ok(())
}

fn validate_mapping_value(field: &'static str, value: &str) -> Result<()> {
  if value.is_empty() || value.len() > MAX_SESSION_VALUE_BYTES {
    return Err(invalid_session_state(format!(
      "{field} is empty or exceeds the maximum byte length"
    )));
  }
  Ok(())
}

#[derive(Clone, Copy)]
struct SessionPlaceholderParams<'a> {
  placeholder: &'a str,
  label_key: &'a str,
  session_id: &'a str,
}

fn session_placeholder_count(
  params: SessionPlaceholderParams<'_>,
) -> Result<u32> {
  let SessionPlaceholderParams {
    placeholder,
    label_key,
    session_id,
  } = params;
  let encoded_session_id = encode_session_namespace(session_id);
  let prefix = format!("[{label_key}_{encoded_session_id}_");
  let Some(number) = placeholder
    .strip_prefix(&prefix)
    .and_then(|value| value.strip_suffix(']'))
  else {
    return Err(invalid_session_state(
      "mapping placeholder does not match its label and session id",
    ));
  };
  if number.is_empty()
    || !number.chars().all(|character| character.is_ascii_digit())
  {
    return Err(invalid_session_state(
      "mapping placeholder count must contain only ASCII digits",
    ));
  }
  if number.starts_with('0') {
    return Err(invalid_session_state(
      "mapping placeholder count must not have a leading zero",
    ));
  }
  let count = number.parse::<u32>().map_err(|_| {
    invalid_session_state("mapping placeholder count is not a valid u32")
  })?;
  if count == 0 {
    return Err(invalid_session_state(
      "mapping placeholder count must be greater than zero",
    ));
  }
  Ok(count)
}

fn invalid_session_state(reason: impl Into<String>) -> Error {
  Error::InvalidSessionState {
    reason: reason.into(),
  }
}

fn session_size_overflow() -> Error {
  invalid_session_state("session state byte length overflowed")
}

#[derive(Serialize)]
struct SessionEnvelopeRef<'a> {
  schema_version: u32,
  session_id: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  lifecycle: Option<SessionLifecycleRef>,
  counters: &'a BTreeMap<String, u32>,
  mappings: Vec<SessionMappingRef<'a>>,
}

#[derive(Serialize)]
struct SessionLifecycleRef {
  created_at_epoch_seconds: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  expires_at_epoch_seconds: Option<u32>,
}

impl From<SessionLifecycle> for SessionLifecycleRef {
  fn from(value: SessionLifecycle) -> Self {
    Self {
      created_at_epoch_seconds: value.created_at.epoch_seconds(),
      expires_at_epoch_seconds: value
        .expires_at
        .map(SessionTimestamp::epoch_seconds),
    }
  }
}

#[derive(Serialize)]
struct SessionMappingRef<'a> {
  label_key: &'a str,
  normalized_text: &'a str,
  placeholder: &'a str,
  original: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionEnvelope {
  schema_version: u32,
  session_id: String,
  #[serde(default)]
  lifecycle: Option<SessionLifecycleWire>,
  counters: BTreeMap<String, u32>,
  mappings: Vec<SessionMappingWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionLifecycleWire {
  created_at_epoch_seconds: u32,
  #[serde(default)]
  expires_at_epoch_seconds: Option<u32>,
}

impl TryFrom<SessionLifecycleWire> for SessionLifecycle {
  type Error = Error;

  fn try_from(value: SessionLifecycleWire) -> Result<Self> {
    Self::new(
      SessionTimestamp::from_epoch_seconds(value.created_at_epoch_seconds),
      value
        .expires_at_epoch_seconds
        .map(SessionTimestamp::from_epoch_seconds),
    )
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionMappingWire {
  label_key: String,
  normalized_text: String,
  placeholder: String,
  original: String,
}
