use std::time::Instant;

use crate::diagnostics::StaticRedactionDiagnostics;
use crate::redact::redact_text;
use crate::resolution::PipelineEntity;
use crate::types::{
  Entity, EntityKind, OperatorConfig, RedactionResult, Result,
};

use super::diagnostic_stream::DiagnosticEventStream;
use super::results::StaticRedactionResult;
use super::timing::elapsed_us;
use super::{PreparedSearch, observe_diagnostic_stream};

impl PreparedSearch {
  pub(super) fn redact_static_entities_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    event_stream: &mut DiagnosticEventStream<'_>,
  ) -> Result<StaticRedactionResult> {
    let redact_start = Instant::now();
    let detections = self
      .detect_static_entities_inner(full_text, diagnostics.as_deref_mut())?;
    observe_diagnostic_stream(&diagnostics, event_stream)?;
    let resolved_entities = self.resolve_static_entities(
      &detections,
      full_text,
      &mut diagnostics,
      event_stream,
    )?;
    let redaction_entities = resolved_entities
      .iter()
      .map(to_redaction_entity)
      .collect::<Vec<_>>();
    let redaction_start = Instant::now();
    let redaction = redact_text(full_text, &redaction_entities, operators)?;
    record_redaction_stages(
      &mut diagnostics,
      &redaction,
      full_text.len(),
      redaction_start,
      redact_start,
    );
    observe_diagnostic_stream(&diagnostics, event_stream)?;

    Ok(StaticRedactionResult {
      detections,
      resolved_entities,
      redaction,
    })
  }
}

fn record_redaction_stages(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  redaction: &RedactionResult,
  input_bytes: usize,
  redaction_start: Instant,
  total_start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_redaction(
    redaction,
    Some(elapsed_us(redaction_start)),
    input_bytes,
  );
  diagnostics.record_stage(
    crate::diagnostics::DiagnosticStage::RedactTotal,
    Some(redaction.entity_count),
    Some(elapsed_us(total_start)),
    Some(input_bytes),
  );
}

fn to_redaction_entity(entity: &PipelineEntity) -> Entity {
  match &entity.kind {
    EntityKind::Detected => Entity::detected(
      entity.start,
      entity.end,
      entity.label.clone(),
      entity.text.clone(),
    ),
    EntityKind::Coreference { source_text } => Entity::coreference(
      entity.start,
      entity.end,
      entity.label.clone(),
      entity.text.clone(),
      source_text.clone(),
    ),
  }
}
