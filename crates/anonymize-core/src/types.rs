use std::collections::BTreeMap;
use std::{error, fmt};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
  InvalidCallerDetection {
    field: &'static str,
    reason: String,
  },
  InvalidSpan {
    start: u32,
    end: u32,
  },
  ByteOffsetOutOfBounds {
    offset: u32,
  },
  ByteOffsetInsideCodepoint {
    offset: u32,
  },
  Search {
    engine: SearchEngine,
    reason: String,
  },
  InvalidPackedSearchResult {
    engine: SearchEngine,
    len: usize,
  },
  PatternIndexOutOfRange {
    index: usize,
  },
  PatternIndexNotAddressable {
    pattern: u32,
  },
  UnsupportedRegexValidation {
    pattern: u32,
  },
  UnsupportedStaticSlice {
    slice: &'static str,
  },
  UnsupportedDenyListSource {
    source: String,
  },
  MissingStaticData {
    field: &'static str,
  },
  InvalidStaticData {
    field: &'static str,
    reason: String,
  },
  StaticDataLengthMismatch {
    field: &'static str,
    expected: usize,
    actual: usize,
  },
}

impl fmt::Display for Error {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::InvalidCallerDetection { field, reason } => {
        write!(
          formatter,
          "Caller detection field '{field}' is invalid: {reason}"
        )
      }
      Self::InvalidSpan { start, end } => {
        write!(formatter, "Invalid entity span: {start}..{end}")
      }
      Self::ByteOffsetOutOfBounds { offset } => {
        write!(formatter, "Byte offset is out of bounds: {offset}")
      }
      Self::ByteOffsetInsideCodepoint { offset } => {
        write!(formatter, "Byte offset is not a UTF-8 boundary: {offset}")
      }
      Self::Search { engine, reason } => {
        write!(formatter, "{engine} search failed: {reason}")
      }
      Self::InvalidPackedSearchResult { engine, len } => {
        write!(
          formatter,
          "{engine} search returned malformed packed matches of length {len}"
        )
      }
      Self::PatternIndexOutOfRange { index } => {
        write!(formatter, "Search pattern index exceeds u32 range: {index}")
      }
      Self::PatternIndexNotAddressable { pattern } => {
        write!(
          formatter,
          "Search pattern index is not addressable: {pattern}"
        )
      }
      Self::UnsupportedRegexValidation { pattern } => {
        write!(
          formatter,
          "Regex pattern {pattern} requires validation that is not available in core"
        )
      }
      Self::UnsupportedStaticSlice { slice } => {
        write!(
          formatter,
          "Static slice '{slice}' is configured but not supported by native core"
        )
      }
      Self::UnsupportedDenyListSource { source } => {
        write!(
          formatter,
          "Deny-list source '{source}' is not supported by native core"
        )
      }
      Self::MissingStaticData { field } => {
        write!(formatter, "Static data field '{field}' is required")
      }
      Self::InvalidStaticData { field, reason } => {
        write!(
          formatter,
          "Static data field '{field}' is invalid: {reason}"
        )
      }
      Self::StaticDataLengthMismatch {
        field,
        expected,
        actual,
      } => {
        write!(
          formatter,
          "Static data field '{field}' has {actual} item(s), expected {expected}"
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

/// Source span with UTF-8 byte offsets.
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
  Keep,
}

#[derive(bon::Builder, Clone, Debug, Eq, PartialEq)]
pub struct OperatorConfig {
  #[builder(default)]
  pub operators: BTreeMap<String, OperatorType>,
  #[builder(default = String::from("[REDACTED]"))]
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
  pub source_text: Option<String>,
  pub placeholder: String,
}

/// Deterministic placeholder lookup for one document.
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
    self.get_with_source(label, text, None).or_else(|| {
      self
        .entries
        .iter()
        .find(|entry| entry.label == label && entry.text == text)
        .map(|entry| entry.placeholder.as_str())
    })
  }

  #[must_use]
  pub(crate) fn get_entity(&self, entity: &Entity) -> Option<&str> {
    self.get_with_source(
      &entity.label,
      &entity.text,
      coreference_source_text(entity),
    )
  }

  fn get_with_source(
    &self,
    label: &str,
    text: &str,
    source_text: Option<&str>,
  ) -> Option<&str> {
    self
      .entries
      .iter()
      .find(|entry| {
        entry.label == label
          && entry.text == text
          && entry.source_text.as_deref() == source_text
      })
      .map(|entry| entry.placeholder.as_str())
  }

  pub(super) fn has_entity(&self, entity: &Entity) -> bool {
    self.get_entity(entity).is_some()
  }

  pub(super) fn push_entity(&mut self, entity: &Entity, placeholder: &str) {
    self.entries.push(PlaceholderEntry {
      label: entity.label.clone(),
      text: entity.text.clone(),
      source_text: coreference_source_text(entity).map(ToOwned::to_owned),
      placeholder: placeholder.to_owned(),
    });
  }
}

fn coreference_source_text(entity: &Entity) -> Option<&str> {
  let EntityKind::Coreference { source_text } = &entity.kind else {
    return None;
  };
  Some(source_text)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchEngine {
  Literal,
  Regex,
  Fuzzy,
  Text,
}

impl fmt::Display for SearchEngine {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Literal => formatter.write_str("literal"),
      Self::Regex => formatter.write_str("regex"),
      Self::Fuzzy => formatter.write_str("fuzzy"),
      Self::Text => formatter.write_str("text-search"),
    }
  }
}

/// Search match with the caller's pattern index and UTF-8 byte offsets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchMatch {
  Literal {
    pattern: u32,
    start: u32,
    end: u32,
  },
  Regex {
    pattern: u32,
    start: u32,
    end: u32,
  },
  Fuzzy {
    pattern: u32,
    start: u32,
    end: u32,
    distance: u32,
  },
}

impl SearchMatch {
  #[must_use]
  pub const fn engine(&self) -> SearchEngine {
    match self {
      Self::Literal { .. } => SearchEngine::Literal,
      Self::Regex { .. } => SearchEngine::Regex,
      Self::Fuzzy { .. } => SearchEngine::Fuzzy,
    }
  }

  #[must_use]
  pub const fn pattern(&self) -> u32 {
    match self {
      Self::Literal { pattern, .. }
      | Self::Regex { pattern, .. }
      | Self::Fuzzy { pattern, .. } => *pattern,
    }
  }

  #[must_use]
  pub const fn start(&self) -> u32 {
    match self {
      Self::Literal { start, .. }
      | Self::Regex { start, .. }
      | Self::Fuzzy { start, .. } => *start,
    }
  }

  #[must_use]
  pub const fn end(&self) -> u32 {
    match self {
      Self::Literal { end, .. }
      | Self::Regex { end, .. }
      | Self::Fuzzy { end, .. } => *end,
    }
  }

  #[must_use]
  pub(crate) const fn with_span(self, start: u32, end: u32) -> Self {
    match self {
      Self::Literal { pattern, .. } => Self::Literal {
        pattern,
        start,
        end,
      },
      Self::Regex { pattern, .. } => Self::Regex {
        pattern,
        start,
        end,
      },
      Self::Fuzzy {
        pattern, distance, ..
      } => Self::Fuzzy {
        pattern,
        start,
        end,
        distance,
      },
    }
  }
}
