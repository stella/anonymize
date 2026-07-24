use crate::diagnostics::DiagnosticStage;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  ANCHORED_RULE {
    id: DetectorId::Anchored;
    stage: DiagnosticStage::EntityAnchored;
    inputs: &[
      DetectorInput::FullText,
      DetectorInput::DateData,
      DetectorInput::MonetaryData,
    ];
    active: anchored_is_active;
    detect: detect_anchored;
  }
}

fn anchored_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(
    context.date_data()?.is_some()
      || (context.monetary_extraction()? && context.monetary_data()?.is_some()),
  )
}

fn detect_anchored(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let full_text = context.full_text()?;
  timed_entities(|| {
    let mut entities = Vec::new();
    if let Some(data) = context.date_data()? {
      entities.extend(data.process(full_text)?);
    }
    if context.monetary_extraction()?
      && let Some(data) = context.monetary_data()?
    {
      entities.extend(data.process(full_text)?);
    }
    Ok(entities)
  })
}
