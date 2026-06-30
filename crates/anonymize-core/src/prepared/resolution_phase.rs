use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::false_positives::filter_entity_false_positives;
use crate::hotwords::apply_hotword_rules;
use crate::processors::DenyListFilterData;
use crate::resolution::{
  PipelineEntity, enforce_boundary_consistency, merge_and_dedup,
  sanitize_entities_with_source,
};
use crate::types::{Result, SearchMatch};

use super::PreparedSearch;
use super::diagnostic_stream::DiagnosticEventStream;
use super::entity_filter::{
  clear_internal_source_details, filter_entities_for_config,
  filter_entities_for_labels, filter_entities_for_redaction, label_is_allowed,
};
use super::phase::{
  PhaseTimer, ResolverStep, observe_diagnostic_stream, record_count_stage,
  record_entities, record_resolver_entities,
};
use super::results::StaticDetectionResult;

impl PreparedSearch {
  pub(super) fn resolve_static_entities(
    &self,
    detections: &StaticDetectionResult,
    full_text: &str,
    diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
    event_stream: &mut DiagnosticEventStream<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let pre_threshold_entities = self.prepare_pre_threshold_entities(
      detections,
      full_text,
      diagnostics.as_deref_mut(),
    )?;
    observe_diagnostic_stream(diagnostics, event_stream)?;
    let mut raw_entities = filter_entities_for_redaction(
      pre_threshold_entities,
      full_text,
      self.policy.threshold,
      self.policy.confidence_boost,
      &self.policy.allowed_labels,
    )?;
    let address_context_timer = PhaseTimer::start();
    let address_context_entities =
      self.process_address_context_entities(full_text, &raw_entities)?;
    record_resolver_entities(
      diagnostics,
      event_stream,
      ResolverStep::AddressContext,
      &address_context_entities,
      full_text,
      address_context_timer,
    )?;
    raw_entities.extend(address_context_entities);
    let merge_timer = PhaseTimer::start();
    let merged = merge_and_dedup(&raw_entities);
    let merged = self.extend_monetary_entities(full_text, &merged);
    record_resolver_entities(
      diagnostics,
      event_stream,
      ResolverStep::Merge,
      &merged,
      full_text,
      merge_timer,
    )?;
    let boundary_timer = PhaseTimer::start();
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    record_resolver_entities(
      diagnostics,
      event_stream,
      ResolverStep::Boundary,
      &consistent,
      full_text,
      boundary_timer,
    )?;
    let sanitize_timer = PhaseTimer::start();
    let sanitized_entities =
      sanitize_entities_with_source(&consistent, full_text)?;
    let false_positive_filters =
      self.data.false_positive_filters.as_ref().or_else(|| {
        self
          .data
          .deny_list
          .as_ref()
          .and_then(|data| data.filters.as_ref())
      });
    let mut resolved_entities = filter_entities_for_config(
      filter_entity_false_positives(
        sanitized_entities,
        full_text,
        false_positive_filters,
      )?,
      self.policy.threshold,
      &self.policy.allowed_labels,
    );
    resolved_entities = self.process_coreference_entities(
      full_text,
      resolved_entities,
      false_positive_filters,
      diagnostics.as_deref_mut(),
    )?;
    clear_internal_source_details(&mut resolved_entities);
    record_resolver_entities(
      diagnostics,
      event_stream,
      ResolverStep::Sanitize,
      &resolved_entities,
      full_text,
      sanitize_timer,
    )?;
    Ok(resolved_entities)
  }

  fn prepare_pre_threshold_entities(
    &self,
    detections: &StaticDetectionResult,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let zone_adjusted_entities = self.apply_zone_adjustments(
      detections.all_entities(),
      full_text,
      diagnostics.as_deref_mut(),
    )?;
    self.apply_hotword_entities(
      zone_adjusted_entities,
      full_text,
      &detections.matches.literal,
      diagnostics,
    )
  }

  fn apply_hotword_entities(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    _literal_matches: &[SearchMatch],
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.data.hotwords else {
      return Ok(entities);
    };
    let timer = PhaseTimer::start();
    let adjusted = apply_hotword_rules(
      entities,
      full_text,
      data,
      &self.policy.allowed_labels,
    )?;
    record_count_stage(
      &mut diagnostics,
      DiagnosticStage::EntityHotword,
      adjusted.len(),
      full_text.len(),
      timer,
    );
    Ok(adjusted)
  }

  fn apply_zone_adjustments(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.data.zones else {
      return Ok(entities);
    };

    let timer = PhaseTimer::start();
    let adjusted = data.adjust_entities(full_text, entities)?;
    record_count_stage(
      &mut diagnostics,
      DiagnosticStage::EntityZoneAdjustment,
      adjusted.boosted,
      full_text.len(),
      timer,
    );
    Ok(adjusted.entities)
  }

  fn process_address_context_entities(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    if !label_is_allowed("address", &self.policy.allowed_labels) {
      return Ok(Vec::new());
    }
    let Some(data) = &self.data.address_context else {
      return Ok(Vec::new());
    };
    data.process(full_text, existing_entities)
  }

  fn process_coreference_entities(
    &self,
    full_text: &str,
    existing_entities: Vec<PipelineEntity>,
    false_positive_filters: Option<&DenyListFilterData>,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.data.coreference else {
      return Ok(existing_entities);
    };

    let timer = PhaseTimer::start();
    let coreference_entities =
      data.process(full_text, &existing_entities, self.policy.threshold)?;
    record_entities(
      &mut diagnostics,
      DiagnosticStage::EntityCoreference,
      &coreference_entities,
      full_text,
      timer,
    );
    if coreference_entities.is_empty() {
      return Ok(existing_entities);
    }

    let merged =
      merge_and_dedup(&[existing_entities, coreference_entities].concat());
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    let sanitized = sanitize_entities_with_source(&consistent, full_text)?;
    let filtered = filter_entity_false_positives(
      sanitized,
      full_text,
      false_positive_filters,
    )?;
    Ok(filter_entities_for_labels(
      filtered,
      &self.policy.allowed_labels,
    ))
  }

  fn extend_monetary_entities(
    &self,
    full_text: &str,
    entities: &[PipelineEntity],
  ) -> Vec<PipelineEntity> {
    let Some(data) = &self.data.monetary else {
      return entities.to_vec();
    };
    data.extend_entities(full_text, entities)
  }
}
