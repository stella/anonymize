#![allow(clippy::redundant_pub_crate)]

pub(crate) mod normalize;
mod placeholders;
mod redact;
mod search;
mod types;
pub(crate) mod utf16;

pub use placeholders::build_placeholder_map;
pub use redact::{deanonymise, redact_text};
pub use search::{
  FuzzySearchOptions, LiteralSearchOptions, RegexSearchOptions, SearchIndex,
  SearchOptions, SearchPattern,
};
pub use types::{
  Entity, EntityKind, Error, OperatorConfig, OperatorEntry, OperatorType,
  PlaceholderEntry, PlaceholderMap, RedactionEntry, RedactionResult, Result,
  SearchEngine, SearchMatch,
};
