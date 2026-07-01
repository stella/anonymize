use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, static_detector_rule,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const ANCHORED_RULE;
  id: StaticDetectorId::Anchored;
  stage: DiagnosticStage::EntityAnchored;
  inputs: &[
    StaticDetectorInput::FullText,
    StaticDetectorInput::DateData,
    StaticDetectorInput::MonetaryData,
  ];
  detect: detect_anchored;
}

fn detect_anchored(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let full_text = context.full_text;
  timed_entities(|| {
    let mut entities = Vec::new();
    if let Some(data) = &engine.data.dates {
      entities.extend(data.process(full_text)?);
    }
    if engine.policy.monetary_extraction
      && let Some(data) = &engine.data.monetary
    {
      entities.extend(data.process(full_text)?);
    }
    Ok(entities)
  })
}
