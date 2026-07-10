mod boundary;
mod common;
mod merge;
mod sanitize;
mod types;

pub use boundary::enforce_boundary_consistency;
pub use merge::merge_and_dedup;
pub use sanitize::sanitize_entities;
pub(crate) use sanitize::sanitize_entities_with_source;
pub use types::{
  CallerDetection, CallerDetectionParams, CallerProvenance, DetectionSource,
  PipelineEntity, SourceDetail,
};
