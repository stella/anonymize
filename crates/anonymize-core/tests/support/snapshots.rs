#![allow(dead_code, clippy::redundant_pub_crate)]

use stella_anonymize_core::{
  DiagnosticEvent, DiagnosticEventKind, DiagnosticStage, OperatorType,
  PipelineEntity, RedactionEntry, RedactionResult, SearchEngine,
};

#[derive(serde::Serialize)]
pub(crate) struct RedactionSnapshot {
  redacted_text: String,
  entity_count: usize,
  redaction_map: Vec<RedactionEntrySnapshot>,
  operator_map: Vec<OperatorEntrySnapshot>,
}

#[derive(serde::Serialize)]
struct RedactionEntrySnapshot {
  placeholder: String,
  original: String,
}

#[derive(serde::Serialize)]
struct OperatorEntrySnapshot {
  placeholder: String,
  operator: String,
}

#[derive(serde::Serialize)]
pub(crate) struct DiagnosticsSnapshot {
  redaction: RedactionSnapshot,
  events: Vec<DiagnosticEventSnapshot>,
}

#[derive(serde::Serialize)]
struct DiagnosticEventSnapshot {
  stage: String,
  phase: String,
  kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  slot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  subslot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pattern_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  engine: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pattern: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  source: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  source_detail: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  span: Option<SpanSnapshot>,
  #[serde(skip_serializing_if = "Option::is_none")]
  score: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  span_valid: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  input_bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  artifact_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  artifact_bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  reason: Option<String>,
}

#[derive(serde::Serialize)]
struct SpanSnapshot {
  start: u32,
  end: u32,
}

#[derive(serde::Serialize)]
pub(crate) struct EntityListSnapshot {
  entities: Vec<EntitySnapshot>,
}

#[derive(serde::Serialize)]
struct EntitySnapshot {
  label: String,
  span: SpanSnapshot,
  source: String,
  source_detail: Option<String>,
  score: String,
  text: String,
}

pub(crate) fn redaction_snapshot(
  result: &RedactionResult,
) -> RedactionSnapshot {
  RedactionSnapshot {
    redacted_text: result.redacted_text.clone(),
    entity_count: result.entity_count,
    redaction_map: result
      .redaction_map
      .iter()
      .map(redaction_entry_snapshot)
      .collect(),
    operator_map: result
      .operator_map
      .iter()
      .map(|entry| OperatorEntrySnapshot {
        placeholder: entry.placeholder.clone(),
        operator: operator_name(entry.operator).to_owned(),
      })
      .collect(),
  }
}

pub(crate) fn diagnostics_snapshot(
  redaction: &RedactionResult,
  events: &[DiagnosticEvent],
) -> DiagnosticsSnapshot {
  DiagnosticsSnapshot {
    redaction: redaction_snapshot(redaction),
    events: events.iter().map(diagnostic_event_snapshot).collect(),
  }
}

pub(crate) fn entity_list_snapshot(
  entities: &[PipelineEntity],
) -> EntityListSnapshot {
  EntityListSnapshot {
    entities: entities.iter().map(entity_snapshot).collect(),
  }
}

fn redaction_entry_snapshot(entry: &RedactionEntry) -> RedactionEntrySnapshot {
  RedactionEntrySnapshot {
    placeholder: entry.placeholder.clone(),
    original: entry.original.clone(),
  }
}

fn diagnostic_event_snapshot(
  event: &DiagnosticEvent,
) -> DiagnosticEventSnapshot {
  DiagnosticEventSnapshot {
    stage: stage_name(event.stage),
    phase: format!("{:?}", event.stage.phase()),
    kind: event_kind_name(event.kind),
    count: event.count,
    slot: event.slot,
    subslot: event.subslot,
    pattern_count: event.pattern_count,
    engine: event.engine.map(search_engine_name),
    pattern: event.pattern,
    source: event.source.map(|source| format!("{source:?}")),
    source_detail: event.source_detail.map(|detail| format!("{detail:?}")),
    label: event.label.clone(),
    span: optional_span(event.start, event.end),
    score: event.score.map(format_score),
    span_valid: event.span_valid,
    input_bytes: event.input_bytes,
    artifact_count: event.artifact_count,
    artifact_bytes: event.artifact_bytes,
    reason: event.reason.clone(),
  }
}

fn entity_snapshot(entity: &PipelineEntity) -> EntitySnapshot {
  EntitySnapshot {
    label: entity.label.clone(),
    span: SpanSnapshot {
      start: entity.start,
      end: entity.end,
    },
    source: format!("{:?}", entity.source),
    source_detail: entity.source_detail.map(|detail| format!("{detail:?}")),
    score: format_score(entity.score),
    text: entity.text.clone(),
  }
}

const fn optional_span(
  start: Option<u32>,
  end: Option<u32>,
) -> Option<SpanSnapshot> {
  match (start, end) {
    (Some(start), Some(end)) => Some(SpanSnapshot { start, end }),
    _ => None,
  }
}

const fn operator_name(operator: OperatorType) -> &'static str {
  match operator {
    OperatorType::Replace => "replace",
    OperatorType::Redact => "redact",
    OperatorType::Keep => "keep",
  }
}

fn search_engine_name(engine: SearchEngine) -> String {
  engine.to_string()
}

fn event_kind_name(kind: DiagnosticEventKind) -> String {
  format!("{kind:?}")
}

fn stage_name(stage: DiagnosticStage) -> String {
  format!("{stage:?}")
}

fn format_score(score: f64) -> String {
  format!("{score:.3}")
}
