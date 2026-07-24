use crate::diagnostics::DiagnosticStage;
use crate::signatures::detect_signatures;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  SIGNATURE_RULE {
    id: DetectorId::Signature;
    stage: DiagnosticStage::EntitySignature;
    inputs: &[DetectorInput::FullText];
    uses: &[SupportResource::Signature];
    active: signature_is_active;
    detect: detect_signature;
  }
}

fn signature_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(context.signature_data()?.is_some())
}

fn detect_signature(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let full_text = context.full_text()?;
  timed_entities(|| {
    Ok(
      context.signature_data()?.map_or_else(Vec::new, |data| {
        detect_signatures(full_text, data)
      }),
    )
  })
}
