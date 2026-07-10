use crate::diagnostics::StaticRedactionDiagnostics;
use crate::redact::redact_text;
use crate::resolution::{CallerDetection, PipelineEntity};
use crate::types::{
  Entity, EntityKind, OperatorConfig, RedactionResult, Result,
};

use super::PreparedEngine;
use super::diagnostic_stream::DiagnosticEventStream;
use super::phase::{PhaseTimer, observe_diagnostic_stream};
use super::result_stream::StaticRedactionResultStream;
use super::results::{StaticRedactionResult, StaticRedactionStreamEvent};

impl PreparedEngine {
  pub(super) fn redact_static_entities_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    caller_detections: &[CallerDetection],
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    event_stream: &mut DiagnosticEventStream<'_>,
    result_stream: &mut StaticRedactionResultStream<'_>,
  ) -> Result<StaticRedactionResult> {
    validate_unique_caller_provenance(caller_detections)?;
    let caller_entities = caller_detections
      .iter()
      .cloned()
      .map(|detection| detection.into_pipeline_entity(full_text))
      .collect::<Result<Vec<_>>>()?;
    if !caller_entities.is_empty()
      && let Some(diagnostics) = diagnostics.as_deref_mut()
    {
      diagnostics.record_entities(
        crate::diagnostics::DiagnosticStage::EntityCallerInput,
        &caller_entities,
        full_text,
        None,
      );
    }
    let redact_timer = PhaseTimer::start();
    let detections = self
      .detect_static_entities_inner(full_text, diagnostics.as_deref_mut())?;
    result_stream
      .observe(StaticRedactionStreamEvent::DetectedEntities(&detections))?;
    observe_diagnostic_stream(&diagnostics, event_stream)?;
    let resolved_entities = self.resolve_static_entities(
      &detections,
      &caller_entities,
      full_text,
      &mut diagnostics,
      event_stream,
    )?;
    if !caller_entities.is_empty()
      && let Some(diagnostics) = diagnostics.as_deref_mut()
    {
      if diagnostics.detail == crate::diagnostics::DiagnosticDetail::Summary {
        let retained_count = resolved_entities
          .iter()
          .filter(|entity| entity.caller_provenance.is_some())
          .count();
        diagnostics.record_stage(
          crate::diagnostics::DiagnosticStage::EntityCallerRetained,
          Some(retained_count),
          None,
          Some(full_text.len()),
        );
      } else {
        let retained_caller_entities = resolved_entities
          .iter()
          .filter(|entity| entity.caller_provenance.is_some())
          .cloned()
          .collect::<Vec<_>>();
        diagnostics.record_entities(
          crate::diagnostics::DiagnosticStage::EntityCallerRetained,
          &retained_caller_entities,
          full_text,
          None,
        );
      }
    }
    result_stream.observe(StaticRedactionStreamEvent::ResolvedEntities(
      &resolved_entities,
    ))?;
    let redaction_entities = resolved_entities
      .iter()
      .map(to_redaction_entity)
      .collect::<Vec<_>>();
    let redaction_timer = PhaseTimer::start();
    let redaction = redact_text(full_text, &redaction_entities, operators)?;
    result_stream.observe(StaticRedactionStreamEvent::Redacted(&redaction))?;
    record_redaction_stages(
      &mut diagnostics,
      &redaction,
      full_text.len(),
      redaction_timer,
      redact_timer,
    );
    observe_diagnostic_stream(&diagnostics, event_stream)?;

    Ok(StaticRedactionResult {
      detections,
      resolved_entities,
      redaction,
    })
  }
}

fn validate_unique_caller_provenance(
  detections: &[CallerDetection],
) -> Result<()> {
  let mut identities = std::collections::BTreeSet::new();
  for detection in detections {
    let provenance = detection.provenance();
    if identities.insert((provenance.provider_id(), provenance.detection_id()))
    {
      continue;
    }
    return Err(crate::types::Error::InvalidCallerDetection {
      field: "detection_id",
      reason: String::from("duplicate provider_id/detection_id pair"),
    });
  }
  Ok(())
}

fn record_redaction_stages(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  redaction: &RedactionResult,
  input_bytes: usize,
  redaction_timer: PhaseTimer,
  total_timer: PhaseTimer,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_redaction(
    redaction,
    Some(redaction_timer.elapsed_us()),
    input_bytes,
  );
  diagnostics.record_stage(
    crate::diagnostics::DiagnosticStage::RedactTotal,
    Some(redaction.entity_count),
    Some(total_timer.elapsed_us()),
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
