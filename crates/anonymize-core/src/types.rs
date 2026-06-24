use std::collections::BTreeMap;
use std::{error, fmt};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
  InvalidSpan { start: u32, end: u32 },
  Utf16OffsetOutOfBounds { offset: u32 },
  Utf16OffsetInsideSurrogate { offset: u32 },
}

impl fmt::Display for Error {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::InvalidSpan { start, end } => {
        write!(formatter, "Invalid entity span: {start}..{end}")
      }
      Self::Utf16OffsetOutOfBounds { offset } => {
        write!(formatter, "UTF-16 offset is out of bounds: {offset}")
      }
      Self::Utf16OffsetInsideSurrogate { offset } => {
        write!(
          formatter,
          "UTF-16 offset is not a scalar boundary: {offset}"
        )
      }
    }
  }
}

impl error::Error for Error {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntityKind {
  Detected,
  Coreference { source_text: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub kind: EntityKind,
}

impl Entity {
  #[must_use]
  pub fn detected(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      kind: EntityKind::Detected,
    }
  }

  #[must_use]
  pub fn coreference(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    source_text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      kind: EntityKind::Coreference {
        source_text: source_text.into(),
      },
    }
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OperatorType {
  #[default]
  Replace,
  Redact,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorConfig {
  pub operators: BTreeMap<String, OperatorType>,
  pub redact_string: String,
}

impl Default for OperatorConfig {
  fn default() -> Self {
    Self {
      operators: BTreeMap::new(),
      redact_string: String::from("[REDACTED]"),
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceholderEntry {
  pub label: String,
  pub text: String,
  pub placeholder: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlaceholderMap {
  entries: Vec<PlaceholderEntry>,
}

impl PlaceholderMap {
  #[must_use]
  pub fn entries(&self) -> &[PlaceholderEntry] {
    &self.entries
  }

  #[must_use]
  pub fn get(&self, label: &str, text: &str) -> Option<&str> {
    self
      .entries
      .iter()
      .find(|entry| entry.label == label && entry.text == text)
      .map(|entry| entry.placeholder.as_str())
  }

  pub(super) fn has(&self, label: &str, text: &str) -> bool {
    self.get(label, text).is_some()
  }

  pub(super) fn push(&mut self, label: &str, text: &str, placeholder: &str) {
    self.entries.push(PlaceholderEntry {
      label: label.to_owned(),
      text: text.to_owned(),
      placeholder: placeholder.to_owned(),
    });
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorEntry {
  pub placeholder: String,
  pub operator: OperatorType,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<RedactionEntry>,
  pub operator_map: Vec<OperatorEntry>,
  pub entity_count: usize,
}
