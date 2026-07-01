use crate::signatures::detect_signatures;

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const SIGNATURE_RULE;
  id: DetectorId::Signature;
  inputs: &[DetectorInput::FullText];
  uses: &[SupportResource::Signature];
  active: signature_is_active;
  detect: detect_signature;
}

const fn signature_is_active(context: &StaticDetectorContext<'_>) -> bool {
  context.engine.data.signatures.is_some()
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
