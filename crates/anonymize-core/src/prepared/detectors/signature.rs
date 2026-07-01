use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, static_detector_rule,
};
use crate::prepared::support_resources::SupportResourceId;
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::signatures::detect_signatures;
use crate::types::Result;

use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const SIGNATURE_RULE;
  id: StaticDetectorId::Signature;
  stage: DiagnosticStage::EntitySignature;
  inputs: &[StaticDetectorInput::FullText];
  uses: &[SupportResourceId::Signature];
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
