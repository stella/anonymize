use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::processors::process_regex_matches;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const REGEX_RULE: StaticDetectorRule =
  StaticDetectorRule::declare(
    StaticDetectorSpec::define(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
    )
    .requires(&[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::FullText,
      StaticDetectorInput::RegexMeta,
    ]),
    detect_regex,
  );

pub(in crate::prepared) const CUSTOM_REGEX_RULE: StaticDetectorRule =
  StaticDetectorRule::declare(
    StaticDetectorSpec::define(
      StaticDetectorId::CustomRegex,
      DiagnosticStage::EntityCustomRegex,
    )
    .requires(&[
      StaticDetectorInput::CustomRegexMatches,
      StaticDetectorInput::FullText,
      StaticDetectorInput::CustomRegexMeta,
    ]),
    detect_custom_regex,
  );

fn detect_regex(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    process_regex_matches(
      &matches.regex,
      engine.policy.slices.regex,
      full_text,
      &engine.policy.regex_meta,
    )
  })
}

fn detect_custom_regex(
  context: &StaticDetectorContext<'_>,
  _passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    process_regex_matches(
      &matches.custom_regex,
      engine.policy.slices.custom_regex,
      full_text,
      &engine.policy.custom_regex_meta,
    )
  })
}
