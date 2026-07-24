use crate::diagnostics::DiagnosticStage;
use crate::triggers::process_trigger_matches;
use std::collections::BTreeSet;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  TRIGGER_RULE {
    id: DetectorId::Trigger;
    stage: DiagnosticStage::EntityTrigger;
    inputs: &[
      DetectorInput::RegexMatches,
      DetectorInput::FullText,
      DetectorInput::TitleTokens,
    ];
    uses: &[SupportResource::Triggers];
    active: trigger_is_active;
    detect: detect_trigger;
  }
}

fn trigger_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.regex_matches()?.is_empty() && context.trigger_data()?.is_some())
}

fn detect_trigger(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  timed_entities(|| {
    let Some(data) = context.trigger_data()? else {
      return Ok(Vec::new());
    };
    let empty_title_tokens = BTreeSet::default();
    let title_tokens = context.title_tokens()?.unwrap_or(&empty_title_tokens);
    process_trigger_matches(
      context.regex_matches()?,
      context.triggers_slice()?,
      context.full_text()?,
      data,
      title_tokens,
      diagnostics,
    )
  })
}
