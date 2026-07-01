use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const ANCHORED_RULE;
  id: DetectorId::Anchored;
  stage: DiagnosticStage::EntityAnchored;
  inputs: &[
    DetectorInput::FullText,
    DetectorInput::DateData,
    DetectorInput::MonetaryData,
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
