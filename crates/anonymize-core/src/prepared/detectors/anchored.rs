use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct AnchoredDetector;

impl StaticEntityDetector for AnchoredDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::Anchored)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let mut entities = Vec::new();
      if let Some(data) = &context.engine.data.dates {
        entities.extend(data.process(context.full_text)?);
      }
      if context.engine.policy.monetary_extraction
        && let Some(data) = &context.engine.data.monetary
      {
        entities.extend(data.process(context.full_text)?);
      }
      Ok(entities)
    })
  }
}
