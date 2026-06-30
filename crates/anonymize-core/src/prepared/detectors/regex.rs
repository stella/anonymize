use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticDetectorInput,
  StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::processors::process_regex_matches;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct RegexDetector;

impl StaticEntityDetector for RegexDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::new(
      StaticDetectorId::Regex,
      DiagnosticStage::EntityRegex,
      &[
        StaticDetectorInput::RegexMatches,
        StaticDetectorInput::FullText,
        StaticDetectorInput::RegexMeta,
      ],
    )
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      process_regex_matches(
        &context.matches.regex,
        context.engine.policy.slices.regex,
        context.full_text,
        &context.engine.policy.regex_meta,
      )
    })
  }
}

pub(in crate::prepared) struct CustomRegexDetector;

impl StaticEntityDetector for CustomRegexDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::new(
      StaticDetectorId::CustomRegex,
      DiagnosticStage::EntityCustomRegex,
      &[
        StaticDetectorInput::CustomRegexMatches,
        StaticDetectorInput::FullText,
        StaticDetectorInput::CustomRegexMeta,
      ],
    )
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      process_regex_matches(
        &context.matches.custom_regex,
        context.engine.policy.slices.custom_regex,
        context.full_text,
        &context.engine.policy.custom_regex_meta,
      )
    })
  }
}
