use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorId, StaticDetectorInput,
  StaticDetectorSpec, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::signatures::detect_signatures;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct SignatureDetector;

impl StaticEntityDetector for SignatureDetector {
  fn spec(&self) -> StaticDetectorSpec {
    StaticDetectorSpec::new(
      StaticDetectorId::Signature,
      DiagnosticStage::EntitySignature,
      &[
        StaticDetectorInput::FullText,
        StaticDetectorInput::SignatureData,
      ],
      &[],
    )
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      Ok(
        context
          .engine
          .data
          .signatures
          .as_ref()
          .map_or_else(Vec::new, |data| {
            detect_signatures(context.full_text, data)
          }),
      )
    })
  }
}
