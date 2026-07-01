use crate::diagnostics::DiagnosticStage;
use crate::triggers::process_trigger_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  TRIGGER_RULE {
    id: DetectorId::Trigger;
    stage: DiagnosticStage::EntityTrigger;
    inputs: &[DetectorInput::RegexMatches];
    uses: &[SupportResource::Triggers];
    active: trigger_is_active;
    detect: detect_trigger;
  }
}

const fn trigger_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.regex.is_empty() && context.engine.data.triggers.is_some()
}

fn detect_trigger(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.triggers else {
      return Ok(Vec::new());
    };
    process_trigger_matches(
      &matches.regex,
      engine.policy.slices.triggers,
      full_text,
      data,
      diagnostics,
    )
  })
}
