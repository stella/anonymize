use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const NAME_CORPUS_RULE: StaticDetectorRule =
  StaticDetectorRule::new(
    StaticDetectorSpec::new(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
      &[
        StaticDetectorInput::FullText,
        StaticDetectorInput::NameCorpusData,
        StaticDetectorInput::DenyListEntities,
      ],
      &[StaticDetectorId::DenyList],
    ),
    detect_name_corpus,
  );

fn detect_name_corpus(
  context: &StaticDetectorContext<'_>,
  passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.name_corpus else {
      return Ok(Vec::new());
    };
    data
      .detect_configured(full_text, passes.entities(StaticDetectorId::DenyList))
  })
}
