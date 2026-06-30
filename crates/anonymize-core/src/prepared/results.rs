use crate::diagnostics::StaticRedactionDiagnostics;
use crate::resolution::PipelineEntity;
use crate::types::{RedactionResult, SearchMatch};

use super::PreparedEngine;
use super::timing::StaticEntityPasses;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedEngineMatches {
  pub regex: Vec<SearchMatch>,
  pub custom_regex: Vec<SearchMatch>,
  pub literal: Vec<SearchMatch>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticEntityLayers {
  pub regex: Vec<PipelineEntity>,
  pub custom_regex: Vec<PipelineEntity>,
  pub deny_list: Vec<PipelineEntity>,
  pub gazetteer: Vec<PipelineEntity>,
  pub country: Vec<PipelineEntity>,
  pub anchored: Vec<PipelineEntity>,
  pub trigger: Vec<PipelineEntity>,
  pub signature: Vec<PipelineEntity>,
  pub legal_form: Vec<PipelineEntity>,
  pub address_seed: Vec<PipelineEntity>,
  pub name_corpus: Vec<PipelineEntity>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticDetectionResult {
  pub matches: PreparedEngineMatches,
  pub entities: StaticEntityLayers,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionResult {
  pub detections: StaticDetectionResult,
  pub resolved_entities: Vec<PipelineEntity>,
  pub redaction: RedactionResult,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticRedactionDiagnosticResult {
  pub result: StaticRedactionResult,
  pub diagnostics: StaticRedactionDiagnostics,
}

impl StaticEntityLayers {
  #[must_use]
  pub const fn entity_count(&self) -> usize {
    self
      .regex
      .len()
      .saturating_add(self.custom_regex.len())
      .saturating_add(self.deny_list.len())
      .saturating_add(self.gazetteer.len())
      .saturating_add(self.country.len())
      .saturating_add(self.anchored.len())
      .saturating_add(self.trigger.len())
      .saturating_add(self.signature.len())
      .saturating_add(self.legal_form.len())
      .saturating_add(self.address_seed.len())
      .saturating_add(self.name_corpus.len())
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let mut entities = Vec::with_capacity(self.entity_count());
    entities.extend(self.regex.iter().cloned());
    entities.extend(self.custom_regex.iter().cloned());
    entities.extend(self.deny_list.iter().cloned());
    entities.extend(self.gazetteer.iter().cloned());
    entities.extend(self.country.iter().cloned());
    entities.extend(self.anchored.iter().cloned());
    entities.extend(self.trigger.iter().cloned());
    entities.extend(self.signature.iter().cloned());
    entities.extend(self.legal_form.iter().cloned());
    entities.extend(self.address_seed.iter().cloned());
    entities.extend(self.name_corpus.iter().cloned());
    entities
  }

  pub(super) fn from_passes(passes: StaticEntityPasses) -> Self {
    Self {
      regex: passes.regex.entities,
      custom_regex: passes.custom_regex.entities,
      deny_list: passes.deny_list.entities,
      gazetteer: passes.gazetteer.entities,
      country: passes.country.entities,
      anchored: passes.anchored.entities,
      trigger: passes.trigger.entities,
      signature: passes.signature.entities,
      legal_form: passes.legal_form.entities,
      address_seed: passes.address_seed.entities,
      name_corpus: passes.name_corpus.entities,
    }
  }
}

pub struct PreparedEngineBuildResult {
  pub prepared: PreparedEngine,
  pub diagnostics: StaticRedactionDiagnostics,
}

impl StaticDetectionResult {
  #[must_use]
  pub const fn entity_count(&self) -> usize {
    self.entities.entity_count()
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    self.entities.all_entities()
  }
}
