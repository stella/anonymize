use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::false_positives::filter_entity_false_positives;
use crate::hotwords::apply_hotword_rules;
use crate::processors::DenyListFilterData;
use crate::resolution::{
  PipelineEntity, enforce_boundary_consistency, merge_and_dedup,
  sanitize_entities_with_source,
};
use crate::types::{Result, SearchMatch};

use super::diagnostic_stream::DiagnosticEventStream;
use super::entity_filter::{
  clear_internal_source_details, filter_entities_for_config,
  filter_entities_for_labels, filter_entities_for_redaction, label_is_allowed,
};
use super::results::StaticDetectionResult;
use super::timing::elapsed_us;
use super::{PreparedSearch, observe_diagnostic_stream};

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
      self.threshold,
      self.confidence_boost,
      &self.allowed_labels,
    )?;
    let address_context_start = Instant::now();
    let address_context_entities =
      self.process_address_context_entities(full_text, &raw_entities)?;
    if let Some(diagnostics) = diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::EntityAddressContext,
        &address_context_entities,
        full_text,
        Some(elapsed_us(address_context_start)),
      );
    }
    observe_diagnostic_stream(diagnostics, event_stream)?;
    raw_entities.extend(address_context_entities);
    let merge_start = Instant::now();
    let merged = merge_and_dedup(&raw_entities);
    let merged = self.extend_monetary_entities(full_text, &merged);
    if let Some(diagnostics) = diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Merge,
        &merged,
        full_text,
        Some(elapsed_us(merge_start)),
      );
    }
    observe_diagnostic_stream(diagnostics, event_stream)?;
    let boundary_start = Instant::now();
    let consistent = enforce_boundary_consistency(&merged, full_text)?;
    if let Some(diagnostics) = diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Boundary,
        &consistent,
        full_text,
        Some(elapsed_us(boundary_start)),
      );
    }
    observe_diagnostic_stream(diagnostics, event_stream)?;
    let sanitize_start = Instant::now();
    let sanitized_entities =
      sanitize_entities_with_source(&consistent, full_text)?;
    let false_positive_filters =
      self.false_positive_filters.as_ref().or_else(|| {
        self
          .deny_list_data
          .as_ref()
          .and_then(|data| data.filters.as_ref())
      });
    let mut resolved_entities = filter_entities_for_config(
      filter_entity_false_positives(
        sanitized_entities,
        full_text,
        false_positive_filters,
      )?,
      self.threshold,
      &self.allowed_labels,
    );
    resolved_entities = self.process_coreference_entities(
      full_text,
      resolved_entities,
      false_positive_filters,
      diagnostics.as_deref_mut(),
    )?;
    clear_internal_source_details(&mut resolved_entities);
    if let Some(diagnostics) = diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::Sanitize,
        &resolved_entities,
        full_text,
        Some(elapsed_us(sanitize_start)),
      );
    }
    observe_diagnostic_stream(diagnostics, event_stream)?;
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
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.hotword_data else {
      return Ok(entities);
    };
    let start = Instant::now();
    let adjusted =
      apply_hotword_rules(entities, full_text, data, &self.allowed_labels)?;
    if let Some(diagnostics) = diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::EntityHotword,
        Some(adjusted.len()),
        Some(elapsed_us(start)),
        Some(full_text.len()),
      );
    }
    Ok(adjusted)
  }

  fn apply_zone_adjustments(
    &self,
    entities: Vec<PipelineEntity>,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<Vec<PipelineEntity>> {
    let Some(data) = &self.zone_data else {
      return Ok(entities);
    };

    let start = Instant::now();
    let adjusted = data.adjust_entities(full_text, entities)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::EntityZoneAdjustment,
        Some(adjusted.boosted),
        Some(elapsed_us(start)),
        Some(full_text.len()),
      );
    }
    Ok(adjusted.entities)
  }

  fn process_address_context_entities(
    &self,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    if !label_is_allowed("address", &self.allowed_labels) {
      return Ok(Vec::new());
    }
    let Some(data) = &self.address_context_data else {
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
    let Some(data) = &self.coreference_data else {
      return Ok(existing_entities);
    };

    let start = Instant::now();
    let coreference_entities =
      data.process(full_text, &existing_entities, self.threshold)?;
    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_entities(
        DiagnosticStage::EntityCoreference,
        &coreference_entities,
        full_text,
        Some(elapsed_us(start)),
      );
    }
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
    Ok(filter_entities_for_labels(filtered, &self.allowed_labels))
  }

  fn extend_monetary_entities(
    &self,
    full_text: &str,
    entities: &[PipelineEntity],
  ) -> Vec<PipelineEntity> {
    let Some(data) = &self.monetary_data else {
      return entities.to_vec();
    };
    data.extend_entities(full_text, entities)
  }
}
