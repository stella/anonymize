use std::borrow::Cow;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::false_positives::{
  filter_entity_false_positives, soft_wrapped_city_person_candidate,
};
use crate::hotwords::apply_hotword_rules;
use crate::labels::{ADDRESS_LABEL, PERSON_LABEL};
use crate::normalize::normalize_for_search;
use crate::processors::DenyListFilterData;
use crate::resolution::{
  PipelineEntity, ResolutionDocument,
  enforce_boundary_consistency_with_document, merge_and_dedup,
  sanitize_entities_with_document,
};
use crate::signatures::{PersonSpanTerminators, PreparedSignatureData};
use crate::types::{Result, SearchMatch};

use super::PreparedEngine;
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

impl PreparedEngine {
  pub(super) fn resolve_static_entities(
    &self,
    detections: &StaticDetectionResult,
    caller_entities: &[PipelineEntity],
    full_text: &str,
    diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
    event_stream: &mut DiagnosticEventStream<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let document = ResolutionDocument::new(full_text);
    let resolution_labels = self.resolution_labels();
    let pre_threshold_entities = self.prepare_pre_threshold_entities(
      detections,
      caller_entities,
      full_text,
      diagnostics.as_deref_mut(),
    )?;
    observe_diagnostic_stream(diagnostics, event_stream)?;
    let mut raw_entities = filter_entities_for_redaction(
      pre_threshold_entities,
      full_text,
      self.policy.threshold,
      self.policy.confidence_boost,
      resolution_labels.as_ref(),
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
    let merged = self.extend_monetary_entities(full_text, merged);
    record_resolver_entities(
      diagnostics,
      event_stream,
      ResolverStep::Merge,
      &merged,
      full_text,
      merge_timer,
    )?;
    let boundary_timer = PhaseTimer::start();
    let consistent = enforce_boundary_consistency_with_document(
      merged,
      &document,
      self.person_span_terminators(),
    )?;
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
      sanitize_entities_with_document(consistent, &document)?;
    let false_positive_filters =
      self.data.false_positive_filters.as_ref().or_else(|| {
        self
          .data
          .deny_list
          .as_ref()
          .and_then(|data| data.filters.as_ref())
      });
    let mut resolved_entities = filter_entities_for_config(
      self.filter_false_positives(
        sanitized_entities,
        &document,
        false_positive_filters,
      )?,
      self.policy.threshold,
      &self.policy.allowed_labels,
    );
    resolved_entities = self.process_coreference_entities(
      full_text,
      &document,
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

  fn person_span_terminators(&self) -> PersonSpanTerminators<'_> {
    self
      .data
      .signatures
      .as_ref()
      .map(PreparedSignatureData::person_span_terminators)
      .unwrap_or_default()
  }

  fn resolution_labels(&self) -> Cow<'_, [String]> {
    let labels = &self.policy.allowed_labels;
    if labels.is_empty()
      || !label_is_allowed(ADDRESS_LABEL, labels)
      || label_is_allowed(PERSON_LABEL, labels)
    {
      return Cow::Borrowed(labels);
    }
    let mut expanded = labels.clone();
    expanded.push(String::from(PERSON_LABEL));
    Cow::Owned(expanded)
  }

  fn prepare_pre_threshold_entities(
    &self,
    detections: &StaticDetectionResult,
    caller_entities: &[PipelineEntity],
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let mut entities = detections.all_entities();
    entities.extend(caller_entities.iter().cloned());
    let zone_adjusted_entities = self.apply_zone_adjustments(
      entities,
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
    let resolution_labels = self.resolution_labels();
    let adjusted = apply_hotword_rules(
      entities,
      full_text,
      data,
      resolution_labels.as_ref(),
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
    document: &ResolutionDocument<'_>,
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

    let mut all_entities = existing_entities;
    all_entities.extend(coreference_entities);
    let merged = merge_and_dedup(&all_entities);
    let consistent = enforce_boundary_consistency_with_document(
      merged,
      document,
      self.person_span_terminators(),
    )?;
    let sanitized = sanitize_entities_with_document(consistent, document)?;
    let filtered = self.filter_false_positives(
      sanitized,
      document,
      false_positive_filters,
    )?;
    Ok(filter_entities_for_labels(
      filtered,
      &self.policy.allowed_labels,
    ))
  }

  fn filter_false_positives(
    &self,
    entities: Vec<PipelineEntity>,
    document: &ResolutionDocument<'_>,
    filters: Option<&DenyListFilterData>,
  ) -> Result<Vec<PipelineEntity>> {
    let filtered = filter_entity_false_positives(entities, document, filters)?;
    self.reclassify_soft_wrapped_city_people(filtered, document)
  }

  fn reclassify_soft_wrapped_city_people(
    &self,
    entities: Vec<PipelineEntity>,
    document: &ResolutionDocument<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let offsets = document.offsets();
    let mut resolved = Vec::with_capacity(entities.len());
    let mut expanded = Vec::new();
    for mut entity in entities {
      let Some(candidate) =
        soft_wrapped_city_person_candidate(&entity, document.text(), &offsets)?
      else {
        resolved.push(entity);
        continue;
      };
      if !self.deny_list_contains_city(&candidate.city_name)? {
        resolved.push(entity);
        continue;
      }
      entity.label = String::from(ADDRESS_LABEL);
      entity.end = candidate.end;
      entity.text = offsets.slice(entity.start, candidate.end)?;
      entity.score = entity.score.max(0.9);
      expanded.push(entity);
    }
    if expanded.is_empty() {
      return Ok(resolved);
    }
    resolved.retain(|entity| {
      expanded
        .iter()
        .all(|expanded| !entity_spans_overlap(entity, expanded))
    });
    resolved.extend(expanded);
    resolved.sort_by_key(|entity| (entity.start, entity.end));
    Ok(resolved)
  }

  fn deny_list_contains_city(&self, city_name: &str) -> Result<bool> {
    let Some(data) = &self.data.deny_list else {
      return Ok(false);
    };
    let normalized = normalize_for_search(city_name);
    let Ok(expected_end) = u32::try_from(normalized.len()) else {
      return Ok(false);
    };
    let matches = self.indexes.literals.find_iter(&normalized)?;
    Ok(matches.into_iter().any(|found| {
      found.start() == 0
        && found.end() == expected_end
        && self
          .policy
          .slices
          .deny_list
          .local_index(found.pattern())
          .is_some_and(|index| data.pattern_has_city_source(index))
    }))
  }

  fn extend_monetary_entities(
    &self,
    full_text: &str,
    entities: Vec<PipelineEntity>,
  ) -> Vec<PipelineEntity> {
    self
      .data
      .anchored
      .extend_monetary_entities(full_text, entities)
  }
}

const fn entity_spans_overlap(
  left: &PipelineEntity,
  right: &PipelineEntity,
) -> bool {
  left.start < right.end && right.start < left.end
}
