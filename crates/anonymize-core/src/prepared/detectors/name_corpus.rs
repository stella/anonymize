use std::time::Instant;

use crate::diagnostics::DiagnosticStage;
use crate::name_corpus::NameCorpusDetectionProfile;

use super::prelude::*;
use super::elapsed_us;

static_detector_rule! {
  pub(in crate::prepared) const NAME_CORPUS_RULE;
  id: DetectorId::NameCorpus;
  stage: DiagnosticStage::EntityNameCorpus;
  inputs: &[
    DetectorInput::FullText,
    DetectorInput::DenyListEntities,
  ];
  after: &[DetectorId::DenyList];
  uses: &[SupportResource::NameCorpus];
  active: name_corpus_is_active;
  detect: detect_name_corpus;
}

pub(in crate::prepared) const RULES: &[StaticDetectorRule] = &[NAME_CORPUS_RULE];

const fn name_corpus_is_active(context: &StaticDetectorContext<'_>) -> bool {
  context.engine.data.name_corpus.is_some()
}

fn detect_name_corpus(
  context: &StaticDetectorContext<'_>,
  passes: &StaticEntityPasses,
  diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let full_text = context.full_text;
  let start = Instant::now();
  let Some(data) = &engine.data.name_corpus else {
    return Ok(TimedEntities::empty());
  };
  let detection = data.detect_configured_profiled(
    full_text,
    passes.entities(DetectorId::DenyList),
  )?;
  record_name_corpus_profile(diagnostics, &detection.profile, full_text.len());
  Ok(TimedEntities {
    entities: detection.entities,
    elapsed_us: elapsed_us(start),
  })
}

fn record_name_corpus_profile(
  diagnostics: StaticDetectorDiagnostics<'_>,
  profile: &NameCorpusDetectionProfile,
  input_bytes: usize,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusCjk,
    Some(profile.cjk_count),
    Some(profile.cjk_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusSegment,
    Some(profile.word_count),
    Some(profile.segment_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusSeed,
    Some(profile.supplemental_seed_count),
    Some(profile.supplemental_seed_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusClassify,
    Some(profile.token_count),
    Some(profile.classify_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusChains,
    Some(profile.token_entity_count),
    Some(profile.chain_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusDedupe,
    Some(profile.dedupe_count),
    Some(profile.dedupe_elapsed_us),
    Some(input_bytes),
  );
  diagnostics.record_stage(
    DiagnosticStage::EntityNameCorpusFilter,
    Some(profile.filter_count),
    Some(profile.filter_elapsed_us),
    Some(input_bytes),
  );
}
