#![allow(clippy::redundant_pub_crate)]

//! Core anonymization contracts shared by host-language bindings.

pub(crate) mod normalize;
mod placeholders;
mod processors;
mod redact;
mod resolution;
mod search;
mod types;
pub(crate) mod utf16;

pub use normalize::normalize_for_search;
pub use placeholders::build_placeholder_map;
pub use processors::{
  CountryMatchData, GazetteerMatchData, PatternSlice, RegexMatchMeta,
  process_country_matches, process_gazetteer_matches, process_regex_matches,
};
pub use redact::{deanonymise, redact_text};
pub use resolution::{
  DetectionSource, PipelineEntity, SourceDetail, enforce_boundary_consistency,
  merge_and_dedup, sanitize_entities,
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
