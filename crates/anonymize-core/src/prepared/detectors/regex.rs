use crate::diagnostics::DiagnosticStage;
use crate::processors::process_regex_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const REGEX_RULE;
  id: DetectorId::Regex;
  stage: DiagnosticStage::EntityRegex;
  inputs: &[
    DetectorInput::RegexMatches,
    DetectorInput::FullText,
    DetectorInput::RegexMeta,
  ];
  active: regex_is_active;
  detect: detect_regex;
}

static_detector_rule! {
  pub(in crate::prepared) const CUSTOM_REGEX_RULE;
  id: DetectorId::CustomRegex;
  stage: DiagnosticStage::EntityCustomRegex;
  inputs: &[
    DetectorInput::CustomRegexMatches,
    DetectorInput::FullText,
    DetectorInput::CustomRegexMeta,
  ];
  active: custom_regex_is_active;
  detect: detect_custom_regex;
}

const fn regex_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.regex.is_empty()
    && !context.engine.policy.regex_meta.is_empty()
}

const fn custom_regex_is_active(context: &StaticDetectorContext<'_>) -> bool {
  !context.matches.custom_regex.is_empty()
    && !context.engine.policy.custom_regex_meta.is_empty()
}

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
