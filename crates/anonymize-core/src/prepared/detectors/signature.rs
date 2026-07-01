use crate::signatures::detect_signatures;

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const SIGNATURE_RULE;
  id: DetectorId::Signature;
  stage: DiagnosticStage::EntitySignature;
  inputs: &[DetectorInput::FullText];
  uses: &[SupportResource::Signature];
  detect: detect_signature;
}

fn detect_signature(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let full_text = context.full_text;
  timed_entities(|| {
    Ok(
      engine
        .data
        .signatures
        .as_ref()
        .map_or_else(Vec::new, |data| detect_signatures(full_text, data)),
    )
  })
}
