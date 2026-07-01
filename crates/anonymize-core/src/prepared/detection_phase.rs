use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::types::Result;

use super::PreparedEngine;
use super::detector_contract::{StaticDetectorContext, StaticDetectorId};
use super::detectors::STATIC_ENTITY_RULES;
use super::phase::record_detector_entities;
use super::results::{
  PreparedEngineMatches, StaticDetectionResult, StaticEntityLayers,
};
use super::timing::{StaticEntityPasses, TimedEntities, elapsed_us};

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
    let mut passes = StaticEntityPasses::new();
    let context = StaticDetectorContext {
      engine: self,
      matches,
      full_text,
    };
    for rule in STATIC_ENTITY_RULES {
      let spec = rule.spec();
      debug_assert!(
        spec.has_declared_inputs(),
        "static detector registry entries must declare required inputs",
      );
      debug_assert!(
        spec.support_resources().iter().all(|resource| {
          let resource_spec = resource.spec();
          resource_spec.id() == *resource
            && resource_spec
              .detector_input()
              .is_some_and(|input| spec.declares_input(input))
        }),
        "static detector support resources must expose declared inputs",
      );
      if !detector_is_active(spec.id(), &context) {
        passes.push_detector_entities(spec.id(), TimedEntities::empty());
        continue;
      }
      let entities =
        rule.detect(&context, &passes, diagnostics.as_deref_mut())?;
      passes.push_detector_entities(spec.id(), entities);
    }
    Ok(passes)
  }
}

const fn detector_is_active(
  detector: StaticDetectorId,
  context: &StaticDetectorContext<'_>,
) -> bool {
  let data = &context.engine.data;
  match detector {
    StaticDetectorId::Regex => {
      !context.matches.regex.is_empty()
        && !context.engine.policy.regex_meta.is_empty()
    }
    StaticDetectorId::CustomRegex => {
      !context.matches.custom_regex.is_empty()
        && !context.engine.policy.custom_regex_meta.is_empty()
    }
    StaticDetectorId::DenyList => {
      !context.matches.literal.is_empty() && data.deny_list.is_some()
    }
    StaticDetectorId::Gazetteer => {
      !context.matches.literal.is_empty() && data.gazetteer.is_some()
    }
    StaticDetectorId::Country => {
      !context.matches.literal.is_empty() && data.countries.is_some()
    }
    StaticDetectorId::Anchored => {
      data.dates.is_some()
        || (context.engine.policy.monetary_extraction
          && data.monetary.is_some())
    }
    StaticDetectorId::Trigger => {
      !context.matches.regex.is_empty() && data.triggers.is_some()
    }
    StaticDetectorId::Signature => data.signatures.is_some(),
    StaticDetectorId::LegalForm => {
      !context.matches.regex.is_empty() && data.legal_forms.is_some()
    }
    StaticDetectorId::NameCorpus => data.name_corpus.is_some(),
    StaticDetectorId::AddressSeed => data.address_seed.is_some(),
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
      detector.has_declared_inputs(),
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
