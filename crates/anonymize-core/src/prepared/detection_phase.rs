use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::types::Result;

use super::PreparedEngine;
use super::detector_registry::{STATIC_ENTITY_RULES, StaticDetectorContext};
use super::phase::record_detector_entities;
use super::results::{
  PreparedEngineMatches, StaticDetectionResult, StaticEntityLayers,
};
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
      entities: StaticEntityLayers::from_passes(passes),
    })
  }

  fn process_static_entity_passes(
    &self,
    matches: &PreparedEngineMatches,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticEntityPasses> {
    let mut passes =
      StaticEntityPasses::with_capacity(STATIC_ENTITY_RULES.len());
    let context = StaticDetectorContext {
      engine: self,
      matches,
      full_text,
    };
    for rule in STATIC_ENTITY_RULES {
      let spec = rule.spec();
      debug_assert!(
        !spec.required_inputs().is_empty(),
        "static detector registry entries must declare required inputs",
      );
      let entities =
        rule.detect(&context, &passes, diagnostics.as_deref_mut())?;
      passes.push_detector_entities(spec.id(), entities);
    }
    Ok(passes)
  }
}

fn record_static_entity_diagnostics(
  diagnostics: &mut StaticRedactionDiagnostics,
  full_text: &str,
  passes: &StaticEntityPasses,
) {
  for rule in STATIC_ENTITY_RULES {
    let detector = rule.spec();
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
