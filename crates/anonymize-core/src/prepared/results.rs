use crate::diagnostics::StaticRedactionDiagnostics;
use crate::resolution::PipelineEntity;
use crate::types::{RedactionResult, SearchMatch};

use super::PreparedEngine;
use super::detector_contract::StaticDetectorId;
use super::timing::StaticEntityPasses;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedEngineMatches {
  pub regex: Vec<SearchMatch>,
  pub custom_regex: Vec<SearchMatch>,
  pub literal: Vec<SearchMatch>,
}

#[derive(Clone, Debug, PartialEq)]
struct StaticEntityLayer {
  detector: StaticDetectorId,
  entities: Vec<PipelineEntity>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticEntityLayers {
  layers: Vec<StaticEntityLayer>,
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
  pub fn entity_count(&self) -> usize {
    self
      .layers
      .iter()
      .map(|layer| layer.entities.len())
      .fold(0usize, usize::saturating_add)
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    let mut entities = Vec::with_capacity(self.entity_count());
    for layer in &self.layers {
      entities.extend(layer.entities.iter().cloned());
    }
    entities
  }

  #[must_use]
  pub fn regex(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Regex)
  }

  #[must_use]
  pub fn custom_regex(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::CustomRegex)
  }

  #[must_use]
  pub fn deny_list(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::DenyList)
  }

  #[must_use]
  pub fn gazetteer(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Gazetteer)
  }

  #[must_use]
  pub fn country(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Country)
  }

  #[must_use]
  pub fn anchored(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Anchored)
  }

  #[must_use]
  pub fn trigger(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Trigger)
  }

  #[must_use]
  pub fn signature(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::Signature)
  }

  #[must_use]
  pub fn legal_form(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::LegalForm)
  }

  #[must_use]
  pub fn name_corpus(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::NameCorpus)
  }

  #[must_use]
  pub fn address_seed(&self) -> &[PipelineEntity] {
    self.entities_for(StaticDetectorId::AddressSeed)
  }

  fn entities_for(&self, detector: StaticDetectorId) -> &[PipelineEntity] {
    self
      .layers
      .iter()
      .find(|layer| layer.detector == detector)
      .map_or(&[], |layer| layer.entities.as_slice())
  }

  pub(super) fn from_passes(passes: StaticEntityPasses) -> Self {
    Self {
      layers: passes
        .into_layers()
        .into_iter()
        .map(|layer| StaticEntityLayer {
          detector: layer.detector,
          entities: layer.timed.entities,
        })
        .collect(),
    }
  }
}

pub struct PreparedEngineBuildResult {
  pub prepared: PreparedEngine,
  pub diagnostics: StaticRedactionDiagnostics,
}

impl StaticDetectionResult {
  #[must_use]
  pub fn entity_count(&self) -> usize {
    self.entities.entity_count()
  }

  #[must_use]
  pub fn all_entities(&self) -> Vec<PipelineEntity> {
    self.entities.all_entities()
  }
}
