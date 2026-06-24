#![allow(clippy::redundant_pub_crate)]

pub(crate) mod normalize;
mod placeholders;
mod redact;
mod types;
pub(crate) mod utf16;

pub use placeholders::build_placeholder_map;
pub use redact::{deanonymise, redact_text};
pub use types::{
  Entity, EntityKind, Error, OperatorConfig, OperatorEntry, OperatorType,
  PlaceholderEntry, PlaceholderMap, RedactionEntry, RedactionResult, Result,
};
