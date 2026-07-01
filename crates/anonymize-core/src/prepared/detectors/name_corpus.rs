use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorId, StaticDetectorInput,
  StaticDetectorSpec, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct NameCorpusDetector;

impl StaticEntityDetector for NameCorpusDetector {
  fn spec(&self) -> StaticDetectorSpec {
    StaticDetectorSpec::new(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
      &[
        StaticDetectorInput::FullText,
        StaticDetectorInput::NameCorpusData,
        StaticDetectorInput::DenyListEntities,
      ],
      &[StaticDetectorId::DenyList],
    )
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
      data.detect_configured(
        context.full_text,
        passes.entities(StaticDetectorId::DenyList),
      )
    })
  }
}
