use std::time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::legal_forms::process_legal_form_matches;
use crate::processors::{
  process_country_matches, process_deny_list_matches,
  process_gazetteer_matches, process_regex_matches,
};
use crate::resolution::PipelineEntity;
use crate::signatures::detect_signatures;
use crate::triggers::process_trigger_matches;
use crate::types::Result;

use super::PreparedSearch;
use super::detector_registry::STATIC_DETECTORS;
use super::phase::record_detector_entities;
use super::results::{PreparedSearchMatches, StaticDetectionResult};
use super::timing::{StaticEntityPasses, TimedEntities, elapsed_us};

impl PreparedSearch {
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
    matches: &PreparedSearchMatches,
    full_text: &str,
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<StaticEntityPasses> {
    let regex_start = Instant::now();
    let regex = TimedEntities {
      entities: process_regex_matches(
        &matches.regex,
        self.policy.slices.regex,
        full_text,
        &self.policy.regex_meta,
      )?,
      elapsed_us: elapsed_us(regex_start),
    };

    let custom_regex_start = Instant::now();
    let custom_regex = TimedEntities {
      entities: process_regex_matches(
        &matches.custom_regex,
        self.policy.slices.custom_regex,
        full_text,
        &self.policy.custom_regex_meta,
      )?,
      elapsed_us: elapsed_us(custom_regex_start),
    };

    let deny_list_start = Instant::now();
    let deny_list = TimedEntities {
      entities: if let Some(data) = &self.data.deny_list {
        process_deny_list_matches(
          &matches.literal,
          self.policy.slices.deny_list,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(deny_list_start),
    };

    let gazetteer_start = Instant::now();
    let gazetteer = TimedEntities {
      entities: if let Some(data) = &self.data.gazetteer {
        process_gazetteer_matches(
          &matches.literal,
          self.policy.slices.gazetteer,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(gazetteer_start),
    };

    let country = self.process_country_entities(matches, full_text)?;

    let anchored = self.process_anchored_entities(full_text)?;

    let trigger =
      self.process_trigger_entities(matches, full_text, diagnostics)?;

    let signature = self.process_signature_entities(full_text);

    let legal_form = self.process_legal_form_entities(matches, full_text)?;

    let name_corpus =
      self.process_name_corpus_entities(full_text, &deny_list.entities)?;

    let address_seed = self.process_address_seed_entities(
      matches,
      full_text,
      &[
        &regex.entities,
        &custom_regex.entities,
        &anchored.entities,
        &trigger.entities,
        &signature.entities,
        &legal_form.entities,
        &deny_list.entities,
        &gazetteer.entities,
        &name_corpus.entities,
      ],
    )?;

    Ok(StaticEntityPasses {
      regex,
      custom_regex,
      deny_list,
      gazetteer,
      country,
      anchored,
      trigger,
      signature,
      legal_form,
      address_seed,
      name_corpus,
    })
  }

  fn process_anchored_entities(
    &self,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let anchored_start = Instant::now();
    let mut entities = Vec::new();
    if let Some(data) = &self.data.dates {
      entities.extend(data.process(full_text)?);
    }
    if self.policy.monetary_extraction
      && let Some(data) = &self.data.monetary
    {
      entities.extend(data.process(full_text)?);
    }

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(anchored_start),
    })
  }

  fn process_trigger_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
    diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.data.triggers {
      process_trigger_matches(
        &matches.regex,
        self.policy.slices.triggers,
        full_text,
        data,
        diagnostics,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_legal_form_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.data.legal_forms {
      process_legal_form_matches(
        &matches.regex,
        self.policy.slices.legal_forms,
        full_text,
        data,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_address_seed_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
    context_layers: &[&[PipelineEntity]],
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.data.address_seed {
      let existing_entities = address_seed_context(context_layers);
      data.process(
        &matches.literal,
        self.policy.slices.street_types,
        full_text,
        &existing_entities,
      )?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_country_entities(
    &self,
    matches: &PreparedSearchMatches,
    full_text: &str,
  ) -> Result<TimedEntities> {
    let country_start = Instant::now();
    Ok(TimedEntities {
      entities: if let Some(data) = &self.data.countries {
        process_country_matches(
          &matches.literal,
          self.policy.slices.countries,
          full_text,
          data,
        )?
      } else {
        Vec::new()
      },
      elapsed_us: elapsed_us(country_start),
    })
  }

  fn process_name_corpus_entities(
    &self,
    full_text: &str,
    deny_list_entities: &[PipelineEntity],
  ) -> Result<TimedEntities> {
    let start = Instant::now();
    let entities = if let Some(data) = &self.data.name_corpus {
      data.detect_configured(full_text, deny_list_entities)?
    } else {
      Vec::new()
    };

    Ok(TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    })
  }

  fn process_signature_entities(&self, full_text: &str) -> TimedEntities {
    let start = Instant::now();
    let entities = self
      .data
      .signatures
      .as_ref()
      .map_or_else(Vec::new, |data| detect_signatures(full_text, data));

    TimedEntities {
      entities,
      elapsed_us: elapsed_us(start),
    }
  }
}

fn record_static_entity_diagnostics(
  diagnostics: &mut StaticRedactionDiagnostics,
  full_text: &str,
  passes: &StaticEntityPasses,
) {
  for detector in STATIC_DETECTORS {
    debug_assert!(
      !detector.required_inputs().is_empty(),
      "static detector registry entries must declare required inputs",
    );
    record_detector_entities(
      diagnostics,
      *detector,
      passes.detector_entities(detector.id()),
      full_text,
    );
  }
}

fn address_seed_context(layers: &[&[PipelineEntity]]) -> Vec<PipelineEntity> {
  let capacity = layers
    .iter()
    .map(|layer| layer.len())
    .fold(0usize, usize::saturating_add);
  let mut entities = Vec::with_capacity(capacity);
  for layer in layers {
    entities.extend(layer.iter().cloned());
  }
  entities
}
