use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticDetectorInput,
  StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::triggers::process_trigger_matches;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct TriggerDetector;

impl StaticEntityDetector for TriggerDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::new(
      StaticDetectorId::Trigger,
      DiagnosticStage::EntityTrigger,
      &[
        StaticDetectorInput::RegexMatches,
        StaticDetectorInput::TriggerData,
      ],
      &[],
    )
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    let diagnostics = context.diagnostics;
    timed_entities(|| {
      let Some(data) = &context.engine.data.triggers else {
        return Ok(Vec::new());
      };
      process_trigger_matches(
        &context.matches.regex,
        context.engine.policy.slices.triggers,
        context.full_text,
        data,
        diagnostics,
      )
    })
  }
}
