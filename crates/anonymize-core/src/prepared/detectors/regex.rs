use crate::diagnostics::DiagnosticStage;
use crate::processors::process_regex_matches;

use super::prelude::*;
use super::timed_entities;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  REGEX_RULE {
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
  CUSTOM_REGEX_RULE {
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
}

fn regex_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(!context.regex_matches()?.is_empty() && !context.regex_meta()?.is_empty())
}

fn custom_regex_is_active(context: &StaticDetectorContext<'_>) -> Result<bool> {
  Ok(
    !context.custom_regex_matches()?.is_empty()
      && !context.custom_regex_meta()?.is_empty(),
  )
}

fn detect_regex(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let full_text = context.full_text()?;
  timed_entities(|| {
    process_regex_matches(
      context.regex_matches()?,
      context.regex_slice()?,
      full_text,
      context.regex_meta()?,
    )
  })
}

fn detect_custom_regex(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let full_text = context.full_text()?;
  timed_entities(|| {
    process_regex_matches(
      context.custom_regex_matches()?,
      context.custom_regex_slice()?,
      full_text,
      context.custom_regex_meta()?,
    )
  })
}
