use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::support_resources::SupportResourceId;
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) const NAME_CORPUS_RULE: StaticDetectorRule =
  StaticDetectorRule::declare(
    StaticDetectorSpec::define(
      StaticDetectorId::NameCorpus,
      DiagnosticStage::EntityNameCorpus,
    )
    .requires(&[
      StaticDetectorInput::FullText,
      StaticDetectorInput::DenyListEntities,
    ])
    .after(&[StaticDetectorId::DenyList])
    .uses(&[SupportResourceId::NameCorpus]),
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
