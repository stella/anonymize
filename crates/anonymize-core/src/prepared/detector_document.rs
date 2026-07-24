use crate::types::Result;

use super::detector_contract::{StaticDetectorInput, StaticDetectorSpec};

/// Document access owned outside the detector contract implementation.
///
/// Keeping the text private to this module makes bypassing a detector's
/// declared `FullText` capability a compile error in detector code and in the
/// context operations that dispatch to it.
pub(super) struct DetectorDocument<'a> {
  full_text: &'a str,
}

impl<'a> DetectorDocument<'a> {
  pub(super) const fn new(full_text: &'a str) -> Self {
    Self { full_text }
  }

  pub(super) fn full_text(&self, spec: StaticDetectorSpec) -> Result<&'a str> {
    spec.require_input(StaticDetectorInput::FullText)?;
    Ok(self.full_text)
  }

  pub(super) const fn len(&self) -> usize {
    self.full_text.len()
  }
}
