#![allow(clippy::redundant_pub_crate)]

//! Core anonymization contracts shared by host-language bindings.

pub(crate) mod normalize;
mod placeholders;
mod redact;
mod resolution;
mod search;
mod types;
pub(crate) mod utf16;

pub use placeholders::build_placeholder_map;
pub use redact::{deanonymise, redact_text};
pub use resolution::{
  DetectionSource, PipelineEntity, SourceDetail, merge_and_dedup,
  sanitize_entities,
};
pub use search::{
  FuzzySearchOptions, LiteralSearchOptions, RegexSearchOptions, SearchIndex,
  SearchOptions, SearchPattern,
};
pub use types::{
  Entity, EntityKind, Error, OperatorConfig, OperatorEntry, OperatorType,
  PlaceholderEntry, PlaceholderMap, RedactionEntry, RedactionResult, Result,
  SearchEngine, SearchMatch,
};
