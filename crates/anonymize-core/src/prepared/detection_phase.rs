use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::types::Result;

use super::PreparedEngine;
use super::detector_registry::{
  STATIC_ENTITY_DETECTORS, StaticDetectorContext,
};
use super::phase::record_detector_entities;
use super::results::{PreparedEngineMatches, StaticDetectionResult};
use super::timing::{StaticEntityPasses, elapsed_us};

impl PreparedEngine {
  pub fn detect_static_entities(
    &self,
    full_text: &str,
  ) -> Result<StaticDetectionResult> {
    self.detect_static_entities_inner(full_text, None)
  }

  pub(super) fn detect_static_entities_inner(
    &self,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticDetectionResult> {
    let detect_start = Instant::now();
    let matches =
      self.find_matches_inner(full_text, diagnostics.as_deref_mut())?;
    let passes = self.process_static_entity_passes(
      &matches,
      full_text,
      diagnostics.as_deref_mut(),
    )?;

    if let Some(diagnostics) = &mut diagnostics {
      diagnostics.record_stage(
        DiagnosticStage::DetectTotal,
        Some(passes.entity_count()),
        Some(elapsed_us(detect_start)),
        Some(full_text.len()),
      );
      record_static_entity_diagnostics(diagnostics, full_text, &passes);
    }

    Ok(StaticDetectionResult {
      matches,
      regex_entities: passes.regex.entities,
      custom_regex_entities: passes.custom_regex.entities,
      deny_list_entities: passes.deny_list.entities,
      gazetteer_entities: passes.gazetteer.entities,
      country_entities: passes.country.entities,
      anchored_entities: passes.anchored.entities,
      trigger_entities: passes.trigger.entities,
      signature_entities: passes.signature.entities,
      legal_form_entities: passes.legal_form.entities,
      address_seed_entities: passes.address_seed.entities,
      name_corpus_entities: passes.name_corpus.entities,
    })
  }

  fn process_static_entity_passes(
    &self,
    matches: &PreparedEngineMatches,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticEntityPasses> {
    let mut passes = StaticEntityPasses::empty();
    for detector in STATIC_ENTITY_DETECTORS {
      let spec = detector.spec();
      debug_assert!(
        !spec.required_inputs().is_empty(),
        "static detector registry entries must declare required inputs",
      );
      let context = StaticDetectorContext {
        engine: self,
        matches,
        full_text,
        diagnostics: diagnostics.as_deref_mut(),
      };
      let entities = detector.detect(context, &passes)?;
      passes.set_detector_entities(spec.id(), entities);
    }
    Ok(passes)
  }
}

fn record_static_entity_diagnostics(
  diagnostics: &mut StaticRedactionDiagnostics,
  full_text: &str,
  passes: &StaticEntityPasses,
) {
  for detector in STATIC_ENTITY_DETECTORS {
    let detector = detector.spec();
    debug_assert!(
      !detector.required_inputs().is_empty(),
      "static detector registry entries must declare required inputs",
    );
    record_detector_entities(
      diagnostics,
      detector,
      passes.detector_entities(detector.id()),
      full_text,
    );
  }
}
