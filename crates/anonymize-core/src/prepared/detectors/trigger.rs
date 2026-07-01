use crate::triggers::process_trigger_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const TRIGGER_RULE;
  id: DetectorId::Trigger;
  inputs: &[DetectorInput::RegexMatches];
  uses: &[SupportResource::Triggers];
  detect: detect_trigger;
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
