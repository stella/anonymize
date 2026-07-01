use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::signatures::detect_signatures;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const SIGNATURE_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::Signature,
      DiagnosticStage::EntitySignature,
      &[
        StaticDetectorInput::FullText,
        StaticDetectorInput::SignatureData,
      ],
      &[],
    ),
    detect_signature,
  );

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
