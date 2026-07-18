//! Conversion of core redaction results and diagnostics into binding
//! DTOs, including UTF-16 and character offset translation.

use serde::Serialize;
use stella_anonymize_core::{
  DiagnosticEvent, PipelineEntity, RedactionResult,
  StaticRedactionDiagnosticResult, StaticRedactionDiagnostics,
  StaticRedactionResult, StaticRedactionStreamEvent,
};

use crate::error::Result;
use crate::names::{
  detection_source_name, diagnostic_event_kind_name, diagnostic_phase_name,
  diagnostic_scope_name, diagnostic_stage_name, operator_name,
  search_engine_name, source_detail_name,
};
use crate::offsets::{CharacterOffsetMap, Utf16OffsetMap};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingRedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingOperatorEntry {
  pub placeholder: String,
  pub operator: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingRedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<BindingRedactionEntry>,
  pub operator_map: Vec<BindingOperatorEntry>,
  pub entity_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingPipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: String,
  pub source_detail: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub provider_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detection_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionResult {
  pub resolved_entities: Vec<BindingPipelineEntity>,
  pub redaction: BindingRedactionResult,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingTextReplacement {
  pub start: u32,
  pub end: u32,
  pub replacement: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BindingStaticRedactionPlanResult {
  pub replacements: Vec<BindingTextReplacement>,
  pub entity_count: usize,
  pub caller_entity_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BindingStaticRedactionStreamEvent {
  DetectedEntities {
    entities: Vec<BindingPipelineEntity>,
  },
  ResolvedEntities {
    entities: Vec<BindingPipelineEntity>,
  },
  Redacted {
    redaction: BindingRedactionResult,
  },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingDiagnosticEvent {
  pub phase: String,
  pub scope: String,
  pub stage: String,
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub slot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub subslot: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pattern_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub engine: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub pattern: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_detail: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub provider_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detection_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub start: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub end: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub score: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub span_valid: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub elapsed_us: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub input_bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub artifact_count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub artifact_bytes: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionDiagnostics {
  pub events: Vec<BindingDiagnosticEvent>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BindingStaticRedactionDiagnosticResult {
  pub result: BindingStaticRedactionResult,
  pub diagnostics: BindingStaticRedactionDiagnostics,
}
#[must_use]
pub fn static_redaction_result_to_binding(
  result: StaticRedactionResult,
) -> BindingStaticRedactionResult {
  BindingStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(binding_pipeline_entity_from_core)
      .collect(),
    redaction: binding_redaction_result_from_core(result.redaction),
  }
}

pub fn static_redaction_result_to_utf16_binding(
  result: StaticRedactionResult,
  full_text: &str,
) -> Result<BindingStaticRedactionResult> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut result = static_redaction_result_to_binding(result);
  convert_pipeline_entity_offsets(&mut result.resolved_entities, &offsets)?;
  Ok(result)
}

pub fn static_redaction_plan_result_to_utf16_binding(
  result: &StaticRedactionResult,
  full_text: &str,
) -> Result<BindingStaticRedactionPlanResult> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let caller_entity_count = result
    .resolved_entities
    .iter()
    .filter(|entity| entity.caller_provenance.is_some())
    .count();
  let entity_count = result.redaction.entity_count;
  let replacements = result
    .redaction
    .replacements
    .iter()
    .map(|replacement| {
      Ok(BindingTextReplacement {
        start: offsets.convert(replacement.start)?,
        end: offsets.convert(replacement.end)?,
        replacement: replacement.replacement.clone(),
      })
    })
    .collect::<Result<Vec<_>>>()?;
  Ok(BindingStaticRedactionPlanResult {
    replacements,
    entity_count,
    caller_entity_count,
  })
}

#[must_use]
pub fn static_redaction_stream_event_to_binding(
  event: StaticRedactionStreamEvent<'_>,
) -> BindingStaticRedactionStreamEvent {
  match event {
    StaticRedactionStreamEvent::DetectedEntities(detections) => {
      BindingStaticRedactionStreamEvent::DetectedEntities {
        entities: detections
          .all_entities()
          .into_iter()
          .map(binding_pipeline_entity_from_core)
          .collect(),
      }
    }
    StaticRedactionStreamEvent::ResolvedEntities(entities) => {
      BindingStaticRedactionStreamEvent::ResolvedEntities {
        entities: entities
          .iter()
          .map(binding_pipeline_entity_from_core_ref)
          .collect(),
      }
    }
    StaticRedactionStreamEvent::Redacted(redaction) => {
      BindingStaticRedactionStreamEvent::Redacted {
        redaction: binding_redaction_result_from_core_ref(redaction),
      }
    }
  }
}

pub fn static_redaction_stream_event_to_utf16_binding(
  event: StaticRedactionStreamEvent<'_>,
  full_text: &str,
) -> Result<BindingStaticRedactionStreamEvent> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut event = static_redaction_stream_event_to_binding(event);
  match &mut event {
    BindingStaticRedactionStreamEvent::DetectedEntities { entities }
    | BindingStaticRedactionStreamEvent::ResolvedEntities { entities } => {
      convert_pipeline_entity_offsets(entities, &offsets)?;
    }
    BindingStaticRedactionStreamEvent::Redacted { .. } => {}
  }
  Ok(event)
}

fn binding_pipeline_entity_from_core(
  entity: PipelineEntity,
) -> BindingPipelineEntity {
  let provenance = entity.caller_provenance;
  BindingPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: detection_source_name(entity.source),
    source_detail: entity.source_detail.map(source_detail_name),
    provider_id: provenance
      .as_ref()
      .map(|value| value.provider_id().to_owned()),
    detection_id: provenance
      .as_ref()
      .map(|value| value.detection_id().to_owned()),
  }
}

fn binding_pipeline_entity_from_core_ref(
  entity: &PipelineEntity,
) -> BindingPipelineEntity {
  BindingPipelineEntity {
    start: entity.start,
    end: entity.end,
    label: entity.label.clone(),
    text: entity.text.clone(),
    score: entity.score,
    source: detection_source_name(entity.source),
    source_detail: entity.source_detail.map(source_detail_name),
    provider_id: entity
      .caller_provenance
      .as_ref()
      .map(|value| value.provider_id().to_owned()),
    detection_id: entity
      .caller_provenance
      .as_ref()
      .map(|value| value.detection_id().to_owned()),
  }
}

fn binding_redaction_result_from_core(
  redaction: RedactionResult,
) -> BindingRedactionResult {
  BindingRedactionResult {
    redacted_text: redaction.redacted_text,
    redaction_map: redaction
      .redaction_map
      .into_iter()
      .map(|entry| BindingRedactionEntry {
        placeholder: entry.placeholder,
        original: entry.original,
      })
      .collect(),
    operator_map: redaction
      .operator_map
      .into_iter()
      .map(|entry| BindingOperatorEntry {
        placeholder: entry.placeholder,
        operator: operator_name(entry.operator),
      })
      .collect(),
    entity_count: redaction.entity_count,
  }
}

fn binding_redaction_result_from_core_ref(
  redaction: &RedactionResult,
) -> BindingRedactionResult {
  BindingRedactionResult {
    redacted_text: redaction.redacted_text.clone(),
    redaction_map: redaction
      .redaction_map
      .iter()
      .map(|entry| BindingRedactionEntry {
        placeholder: entry.placeholder.clone(),
        original: entry.original.clone(),
      })
      .collect(),
    operator_map: redaction
      .operator_map
      .iter()
      .map(|entry| BindingOperatorEntry {
        placeholder: entry.placeholder.clone(),
        operator: operator_name(entry.operator),
      })
      .collect(),
    entity_count: redaction.entity_count,
  }
}

#[must_use]
pub fn static_redaction_diagnostic_result_to_binding(
  result: StaticRedactionDiagnosticResult,
) -> BindingStaticRedactionDiagnosticResult {
  BindingStaticRedactionDiagnosticResult {
    result: static_redaction_result_to_binding(result.result),
    diagnostics: static_redaction_diagnostics_to_binding(result.diagnostics),
  }
}

pub fn static_redaction_diagnostic_result_to_utf16_binding(
  result: StaticRedactionDiagnosticResult,
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnosticResult> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut result = static_redaction_diagnostic_result_to_binding(result);
  convert_pipeline_entity_offsets(
    &mut result.result.resolved_entities,
    &offsets,
  )?;
  convert_diagnostic_offsets(&mut result.diagnostics.events, &offsets)?;
  Ok(result)
}

pub fn static_redaction_diagnostic_result_to_character_binding(
  result: StaticRedactionDiagnosticResult,
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnosticResult> {
  let offsets = CharacterOffsetMap::new(full_text)?;
  let mut result = static_redaction_diagnostic_result_to_binding(result);
  convert_pipeline_entity_character_offsets(
    &mut result.result.resolved_entities,
    &offsets,
  )?;
  convert_diagnostic_character_offsets(
    &mut result.diagnostics.events,
    &offsets,
  )?;
  Ok(result)
}

#[must_use]
pub fn static_redaction_diagnostics_to_binding(
  diagnostics: StaticRedactionDiagnostics,
) -> BindingStaticRedactionDiagnostics {
  BindingStaticRedactionDiagnostics {
    events: diagnostics
      .events
      .into_iter()
      .map(diagnostic_event_to_binding)
      .collect(),
  }
}

pub fn static_redaction_diagnostics_to_utf16_binding(
  diagnostics: StaticRedactionDiagnostics,
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnostics> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut diagnostics = static_redaction_diagnostics_to_binding(diagnostics);
  convert_diagnostic_offsets(&mut diagnostics.events, &offsets)?;
  Ok(diagnostics)
}

#[must_use]
pub fn diagnostic_events_to_binding(
  events: &[DiagnosticEvent],
) -> BindingStaticRedactionDiagnostics {
  BindingStaticRedactionDiagnostics {
    events: events
      .iter()
      .cloned()
      .map(diagnostic_event_to_binding)
      .collect(),
  }
}

pub fn diagnostic_events_to_utf16_binding(
  events: &[DiagnosticEvent],
  full_text: &str,
) -> Result<BindingStaticRedactionDiagnostics> {
  let offsets = Utf16OffsetMap::new(full_text)?;
  let mut diagnostics = diagnostic_events_to_binding(events);
  convert_diagnostic_offsets(&mut diagnostics.events, &offsets)?;
  Ok(diagnostics)
}

fn diagnostic_event_to_binding(
  event: DiagnosticEvent,
) -> BindingDiagnosticEvent {
  BindingDiagnosticEvent {
    phase: diagnostic_phase_name(event.stage.phase()),
    scope: diagnostic_scope_name(event.scope()),
    stage: diagnostic_stage_name(event.stage),
    kind: diagnostic_event_kind_name(event.kind),
    count: event.count,
    slot: event.slot,
    subslot: event.subslot,
    pattern_count: event.pattern_count,
    engine: event.engine.map(search_engine_name),
    pattern: event.pattern,
    source: event.source.map(detection_source_name),
    source_detail: event.source_detail.map(source_detail_name),
    provider_id: event.provider_id,
    detection_id: event.detection_id,
    label: event.label,
    start: event.start,
    end: event.end,
    text: event.text,
    score: event.score,
    span_valid: event.span_valid,
    elapsed_us: event.elapsed_us,
    input_bytes: event.input_bytes,
    artifact_count: event.artifact_count,
    artifact_bytes: event.artifact_bytes,
    reason: event.reason,
  }
}

fn convert_pipeline_entity_offsets(
  entities: &mut [BindingPipelineEntity],
  offsets: &Utf16OffsetMap,
) -> Result<()> {
  for entity in entities {
    entity.start = offsets.convert(entity.start)?;
    entity.end = offsets.convert(entity.end)?;
  }
  Ok(())
}

fn convert_diagnostic_offsets(
  events: &mut [BindingDiagnosticEvent],
  offsets: &Utf16OffsetMap,
) -> Result<()> {
  for event in events {
    if let Some(start) = event.start {
      event.start = Some(offsets.convert(start)?);
    }
    if let Some(end) = event.end {
      event.end = Some(offsets.convert(end)?);
    }
  }
  Ok(())
}

fn convert_pipeline_entity_character_offsets(
  entities: &mut [BindingPipelineEntity],
  offsets: &CharacterOffsetMap,
) -> Result<()> {
  for entity in entities {
    entity.start = offsets.convert(entity.start)?;
    entity.end = offsets.convert(entity.end)?;
  }
  Ok(())
}

fn convert_diagnostic_character_offsets(
  events: &mut [BindingDiagnosticEvent],
  offsets: &CharacterOffsetMap,
) -> Result<()> {
  for event in events {
    if let Some(start) = event.start {
      event.start = Some(offsets.convert(start)?);
    }
    if let Some(end) = event.end {
      event.end = Some(offsets.convert(end)?);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use stella_anonymize_core::{
    DiagnosticEvent, DiagnosticEventKind, DiagnosticStage,
    StaticRedactionDiagnostics,
  };

  use super::{
    diagnostic_events_to_binding, diagnostic_events_to_utf16_binding,
    static_redaction_diagnostics_to_utf16_binding,
  };
  use crate::error::ContractError;
  use crate::package::diagnostic_stage_event;

  #[test]
  fn utf16_diagnostics_reject_invalid_byte_offsets() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
        engine: None,
        pattern: None,
        source: None,
        source_detail: None,
        provider_id: None,
        detection_id: None,
        label: None,
        start: Some(1),
        end: Some(2),
        text: None,
        score: None,
        span_valid: None,
        elapsed_us: None,
        input_bytes: None,
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let error = static_redaction_diagnostics_to_utf16_binding(diagnostics, "á")
      .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidBindingOffset { offset: 1 }
    ));
  }

  #[test]
  fn ascii_diagnostics_reject_out_of_range_offsets() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        start: Some(4),
        end: Some(5),
        ..diagnostic_stage_event(DiagnosticStage::EntityRegex, None, None, None)
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let error =
      static_redaction_diagnostics_to_utf16_binding(diagnostics, "abc")
        .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidBindingOffset { offset: 4 }
    ));
  }

  #[test]
  fn binding_diagnostic_events_include_pipeline_phase() {
    let mut prepare_regex =
      diagnostic_stage_event(DiagnosticStage::PrepareRegex, None, None, None);
    prepare_regex.slot = Some(0);

    let events = vec![
      prepare_regex,
      diagnostic_stage_event(DiagnosticStage::FindLiteral, None, None, None),
      diagnostic_stage_event(DiagnosticStage::EntityDenyList, None, None, None),
      diagnostic_stage_event(DiagnosticStage::EntityHotword, None, None, None),
      diagnostic_stage_event(DiagnosticStage::RedactTotal, None, None, None),
    ];

    let diagnostics = diagnostic_events_to_binding(&events);
    let metadata = diagnostics
      .events
      .iter()
      .map(|event| {
        (
          event.stage.as_str(),
          event.phase.as_str(),
          event.scope.as_str(),
        )
      })
      .collect::<Vec<_>>();

    assert_eq!(
      metadata,
      vec![
        ("prepare.regex", "prepare", "slot"),
        ("find.literal", "search", "step"),
        ("entity.deny-list", "detect", "step"),
        ("entity.hotword", "resolve", "step"),
        ("redact.total", "redact", "total"),
      ]
    );
  }

  #[test]
  fn utf16_diagnostic_event_batches_match_full_diagnostics() {
    let diagnostics = StaticRedactionDiagnostics {
      events: vec![DiagnosticEvent {
        stage: DiagnosticStage::EntityRegex,
        kind: DiagnosticEventKind::Entity,
        count: None,
        slot: None,
        subslot: None,
        pattern_count: None,
        engine: None,
        pattern: None,
        source: None,
        source_detail: None,
        provider_id: None,
        detection_id: None,
        label: Some("name".to_string()),
        start: Some(0),
        end: Some(2),
        text: None,
        score: Some(0.9),
        span_valid: Some(true),
        elapsed_us: Some(12),
        input_bytes: None,
        artifact_count: None,
        artifact_bytes: None,
        reason: None,
      }],
      ..StaticRedactionDiagnostics::default()
    };

    let full =
      static_redaction_diagnostics_to_utf16_binding(diagnostics.clone(), "áx")
        .unwrap();
    let batch =
      diagnostic_events_to_utf16_binding(&diagnostics.events, "áx").unwrap();

    assert_eq!(batch, full);
  }
}
