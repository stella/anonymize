use crate::byte_offsets::ByteOffsets;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::types::{RedactionResult, SearchEngine, SearchMatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticStage {
  PrepareCacheHit,
  PrepareCacheMiss,
  PrepareBindingParse,
  PreparePackageDecode,
  PrepareBindingConvert,
  PrepareArtifactsDecode,
  PrepareTotal,
  PrepareRegex,
  PrepareCustomRegex,
  PrepareAnchored,
  PrepareLegalFormSearch,
  PrepareTriggerSearch,
  PrepareLiteral,
  Normalize,
  FindMatches,
  FindRegex,
  FindCustomRegex,
  FindLiteral,
  SearchRegex,
  SearchCustomRegex,
  SearchLegalForm,
  SearchTrigger,
  SearchLiteral,
  EntityRegex,
  EntityCustomRegex,
  EntityAnchored,
  EntityDenyList,
  EntityGazetteer,
  EntityCountry,
  EntityTrigger,
  EntitySignature,
  EntityLegalForm,
  EntityAddressSeed,
  EntityZoneAdjustment,
  EntityAddressContext,
  EntityCoreference,
  Merge,
  Boundary,
  Sanitize,
  Redaction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticEventKind {
  StageSummary,
  SearchMatch,
  Entity,
  Rejection,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiagnosticEvent {
  pub stage: DiagnosticStage,
  pub kind: DiagnosticEventKind,
  pub count: Option<usize>,
  pub engine: Option<SearchEngine>,
  pub pattern: Option<u32>,
  pub source: Option<DetectionSource>,
  pub source_detail: Option<SourceDetail>,
  pub label: Option<String>,
  pub start: Option<u32>,
  pub end: Option<u32>,
  pub text: Option<String>,
  pub score: Option<f64>,
  pub span_valid: Option<bool>,
  pub elapsed_us: Option<u64>,
  pub input_bytes: Option<usize>,
  pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticRedactionDiagnostics {
  pub events: Vec<DiagnosticEvent>,
}

impl StaticRedactionDiagnostics {
  pub(crate) fn record_search_matches(
    &mut self,
    stage: DiagnosticStage,
    matches: &[SearchMatch],
    full_text: &str,
    elapsed_us: Option<u64>,
  ) {
    self.record_stage(
      stage,
      Some(matches.len()),
      elapsed_us,
      Some(full_text.len()),
    );

    let offsets = ByteOffsets::new(full_text);
    for found in matches {
      let span_valid = span_slices(&offsets, found.start(), found.end());
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::SearchMatch,
        count: None,
        engine: Some(found.engine()),
        pattern: Some(found.pattern()),
        source: None,
        source_detail: None,
        label: None,
        start: Some(found.start()),
        end: Some(found.end()),
        text: None,
        score: None,
        span_valid: Some(span_valid),
        elapsed_us: None,
        input_bytes: None,
        reason: None,
      });
    }
  }

  pub(crate) fn record_entities(
    &mut self,
    stage: DiagnosticStage,
    entities: &[PipelineEntity],
    full_text: &str,
    elapsed_us: Option<u64>,
  ) {
    self.record_stage(
      stage,
      Some(entities.len()),
      elapsed_us,
      Some(full_text.len()),
    );

    let offsets = ByteOffsets::new(full_text);
    for entity in entities {
      self.events.push(DiagnosticEvent {
        stage,
        kind: DiagnosticEventKind::Entity,
        count: None,
        engine: None,
        pattern: None,
        source: Some(entity.source),
        source_detail: entity.source_detail,
        label: Some(entity.label.clone()),
        start: Some(entity.start),
        end: Some(entity.end),
        text: None,
        score: Some(entity.score),
        span_valid: Some(span_slices(&offsets, entity.start, entity.end)),
        elapsed_us: None,
        input_bytes: None,
        reason: None,
      });
    }
  }

  pub(crate) fn record_redaction(
    &mut self,
    result: &RedactionResult,
    elapsed_us: Option<u64>,
    input_bytes: usize,
  ) {
    self.events.push(DiagnosticEvent {
      stage: DiagnosticStage::Redaction,
      kind: DiagnosticEventKind::StageSummary,
      count: Some(result.entity_count),
      engine: None,
      pattern: None,
      source: None,
      source_detail: None,
      label: None,
      start: None,
      end: None,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us,
      input_bytes: Some(input_bytes),
      reason: None,
    });
  }

  pub(crate) fn record_rejection(
    &mut self,
    stage: DiagnosticStage,
    pattern: Option<u32>,
    label: Option<&str>,
    start: Option<u32>,
    end: Option<u32>,
    reason: &'static str,
  ) {
    self.events.push(DiagnosticEvent {
      stage,
      kind: DiagnosticEventKind::Rejection,
      count: None,
      engine: None,
      pattern,
      source: None,
      source_detail: None,
      label: label.map(str::to_owned),
      start,
      end,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us: None,
      input_bytes: None,
      reason: Some(String::from(reason)),
    });
  }

  pub(crate) fn record_stage(
    &mut self,
    stage: DiagnosticStage,
    count: Option<usize>,
    elapsed_us: Option<u64>,
    input_bytes: Option<usize>,
  ) {
    self.events.push(DiagnosticEvent {
      stage,
      kind: DiagnosticEventKind::StageSummary,
      count,
      engine: None,
      pattern: None,
      source: None,
      source_detail: None,
      label: None,
      start: None,
      end: None,
      text: None,
      score: None,
      span_valid: None,
      elapsed_us,
      input_bytes,
      reason: None,
    });
  }

  pub fn extend(&mut self, other: Self) {
    self.events.extend(other.events);
  }
}

fn span_slices(offsets: &ByteOffsets<'_>, start: u32, end: u32) -> bool {
  start <= end
    && offsets.validate_offset(start).is_ok()
    && offsets.validate_offset(end).is_ok()
}
