use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct NameCorpusDetector;

impl StaticEntityDetector for NameCorpusDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::NameCorpus)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.name_corpus else {
        return Ok(Vec::new());
      };
      data.detect_configured(context.full_text, &passes.deny_list.entities)
    })
  }
}
