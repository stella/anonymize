use crate::diagnostics::StaticRedactionDiagnostics;
use crate::resolution::PipelineEntity;
use crate::types::{RedactionResult, SearchMatch};

use super::PreparedEngine;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedEngineMatches {
  pub regex: Vec<SearchMatch>,
  pub custom_regex: Vec<SearchMatch>,
  pub literal: Vec<SearchMatch>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StaticDetectionResult {
  pub matches: PreparedEngineMatches,
  pub regex_entities: Vec<PipelineEntity>,
  pub custom_regex_entities: Vec<PipelineEntity>,
  pub deny_list_entities: Vec<PipelineEntity>,
  pub gazetteer_entities: Vec<PipelineEntity>,
  pub country_entities: Vec<PipelineEntity>,
  pub anchored_entities: Vec<PipelineEntity>,
  pub trigger_entities: Vec<PipelineEntity>,
  pub signature_entities: Vec<PipelineEntity>,
  pub legal_form_entities: Vec<PipelineEntity>,
  pub address_seed_entities: Vec<PipelineEntity>,
  pub name_corpus_entities: Vec<PipelineEntity>,
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

pub struct PreparedEngineBuildResult {
  pub prepared: PreparedEngine,
  pub diagnostics: StaticRedactionDiagnostics,
}

pub type PreparedSearchBuildResult = PreparedEngineBuildResult;
pub type PreparedSearchMatches = PreparedEngineMatches;

impl StaticDetectionResult {
  #[must_use]
  pub const fn entity_count(&self) -> usize {
    self
      .regex_entities
      .len()
      .saturating_add(self.custom_regex_entities.len())
      .saturating_add(self.deny_list_entities.len())
      .saturating_add(self.gazetteer_entities.len())
      .saturating_add(self.country_entities.len())
      .saturating_add(self.anchored_entities.len())
      .saturating_add(self.trigger_entities.len())
      .saturating_add(self.signature_entities.len())
      .saturating_add(self.legal_form_entities.len())
      .saturating_add(self.address_seed_entities.len())
      .saturating_add(self.name_corpus_entities.len())
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let mut entities = Vec::with_capacity(self.entity_count());
    entities.extend(self.regex_entities.iter().cloned());
    entities.extend(self.custom_regex_entities.iter().cloned());
    entities.extend(self.deny_list_entities.iter().cloned());
    entities.extend(self.gazetteer_entities.iter().cloned());
    entities.extend(self.country_entities.iter().cloned());
    entities.extend(self.anchored_entities.iter().cloned());
    entities.extend(self.trigger_entities.iter().cloned());
    entities.extend(self.signature_entities.iter().cloned());
    entities.extend(self.legal_form_entities.iter().cloned());
    entities.extend(self.address_seed_entities.iter().cloned());
    entities.extend(self.name_corpus_entities.iter().cloned());
    entities
  }
}
