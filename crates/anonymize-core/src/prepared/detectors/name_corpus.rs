use super::prelude::*;
use super::timed_entities;

static_detector_rule! {
  pub(in crate::prepared) const NAME_CORPUS_RULE;
  id: DetectorId::NameCorpus;
  inputs: &[
    DetectorInput::FullText,
    DetectorInput::DenyListEntities,
  ];
  after: &[DetectorId::DenyList];
  uses: &[SupportResource::NameCorpus];
  detect: detect_name_corpus;
}

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
      .detect_configured(full_text, passes.entities(DetectorId::DenyList))
  })
}
