use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::triggers::process_trigger_matches;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const TRIGGER_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::Trigger,
      DiagnosticStage::EntityTrigger,
      &[
        StaticDetectorInput::RegexMatches,
        StaticDetectorInput::TriggerData,
      ],
      &[],
    ),
    detect_trigger,
  );

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
