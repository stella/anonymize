use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::placeholders::{
  PlaceholderIdentity, collect_reserved_placeholders, placeholder_identity,
};
use crate::types::{Entity, Error, PlaceholderMap, RedactionEntry, Result};

/// Current schema version for plaintext redaction-session transfer.
pub const REDACTION_SESSION_SCHEMA_VERSION: u32 = 1;

const MAX_SESSION_ID_BYTES: usize = 64;
const MAX_SESSION_MAPPINGS: usize = 100_000;
const MAX_SESSION_STATE_BYTES: usize = 0x0100_0000;
const MAX_SESSION_VALUE_BYTES: usize = 0x0010_0000;
const MAX_PLACEHOLDER_COMPONENT_BYTES: usize = 128;

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
    let namespace_suffix = format!("_{}", self.as_str());
    let collision = reserved.iter().find(|placeholder| {
      placeholder
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .and_then(|value| value.rsplit_once('_'))
        .is_some_and(|(prefix, _)| {
          prefix
            .strip_suffix(&namespace_suffix)
            .is_some_and(|label_key| !label_key.is_empty())
        })
    });
    let Some(placeholder) = collision else {
      return Ok(());
    };
    Err(Error::SessionPlaceholderCollision {
      placeholder: placeholder.clone(),
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
  counters: BTreeMap<String, u32>,
  placeholders: BTreeMap<PlaceholderIdentity, String>,
  originals: BTreeMap<String, String>,
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
}

impl RedactionSession {
  #[must_use]
  pub const fn new(id: SessionId) -> Self {
    Self {
      id,
      counters: BTreeMap::new(),
      placeholders: BTreeMap::new(),
      originals: BTreeMap::new(),
    }
  }

  #[must_use]
  pub const fn id(&self) -> &SessionId {
    &self.id
  }

  #[must_use]
  pub fn mapping_count(&self) -> usize {
    self.placeholders.len()
  }

  /// Serializes plaintext session state deterministically.
  ///
  /// The returned JSON contains original and normalized entity values. It must
  /// not be logged or persisted without an application-owned protection layer.
  pub fn to_plaintext_json(&self) -> Result<String> {
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
      schema_version: REDACTION_SESSION_SCHEMA_VERSION,
      session_id: self.id.as_str(),
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
    if envelope.schema_version != REDACTION_SESSION_SCHEMA_VERSION {
      return Err(Error::UnsupportedSessionVersion {
        version: envelope.schema_version,
      });
    }
    if envelope.mappings.len() > MAX_SESSION_MAPPINGS {
      return Err(invalid_session_state(
        "session state contains too many mappings",
      ));
    }

    let id = SessionId::new(envelope.session_id)?;
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

    Ok(Self {
      id,
      counters: envelope.counters,
      placeholders,
      originals,
    })
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
    Ok(SessionPlaceholderPlan {
      placeholder_map,
      update: SessionUpdate {
        counter_updates,
        new_mappings,
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
  }

  pub(crate) fn validate_reserved_text(&self, text: &str) -> Result<()> {
    self.id.validate_reserved_text(text)
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
      |namespace| format!("[{label_key}_{namespace}_{count}]"),
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
  let prefix = format!("[{label_key}_{session_id}_");
  let Some(number) = placeholder
    .strip_prefix(&prefix)
    .and_then(|value| value.strip_suffix(']'))
  else {
    return Err(invalid_session_state(
      "mapping placeholder does not match its label and session id",
    ));
  };
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

#[derive(Serialize)]
struct SessionEnvelopeRef<'a> {
  schema_version: u32,
  session_id: &'a str,
  counters: &'a BTreeMap<String, u32>,
  mappings: Vec<SessionMappingRef<'a>>,
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
  counters: BTreeMap<String, u32>,
  mappings: Vec<SessionMappingWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionMappingWire {
  label_key: String,
  normalized_text: String,
  placeholder: String,
  original: String,
}
