use crate::processors::process_regex_matches;
use crate::types::Result;

use super::timed_entities;
use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};

pub(in crate::prepared) struct RegexDetector;

impl StaticEntityDetector for RegexDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::Regex)
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
    StaticDetector::by_id(StaticDetectorId::CustomRegex)
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
