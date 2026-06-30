use crate::legal_forms::process_legal_form_matches;
use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct LegalFormDetector;

impl StaticEntityDetector for LegalFormDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::LegalForm)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.legal_forms else {
        return Ok(Vec::new());
      };
      process_legal_form_matches(
        &context.matches.regex,
        context.engine.policy.slices.legal_forms,
        context.full_text,
        data,
      )
    })
  }
}
