use std::time::Instant;

use crate::resolution::PipelineEntity;
use crate::types::SearchMatch;

use super::detector_registry::StaticDetectorId;

pub(super) struct TimedEntities {
  pub(super) entities: Vec<PipelineEntity>,
  pub(super) elapsed_us: u64,
}

impl TimedEntities {
  pub(super) const fn empty() -> Self {
    Self {
      entities: Vec::new(),
      elapsed_us: 0,
    }
  }
}

static EMPTY_TIMED_ENTITIES: TimedEntities = TimedEntities::empty();

pub(super) struct DetectorEntityPass {
  pub(super) detector: StaticDetectorId,
  pub(super) timed: TimedEntities,
}

pub(super) struct TimedMatches {
  pub(super) matches: Vec<SearchMatch>,
  pub(super) elapsed_us: u64,
}

impl TimedMatches {
  pub(super) const fn empty() -> Self {
    Self {
      matches: Vec::new(),
      elapsed_us: 0,
    }
  }
}

pub(super) struct TimedSearchBranches {
  pub(super) regex: TimedMatches,
  pub(super) legal_forms: TimedMatches,
  pub(super) triggers: TimedMatches,
  pub(super) custom_regex: TimedMatches,
  pub(super) literal: TimedMatches,
}

pub(super) struct StaticEntityPasses {
  layers: Vec<DetectorEntityPass>,
}

impl StaticEntityPasses {
  pub(super) const fn empty() -> Self {
    Self { layers: Vec::new() }
  }

  pub(super) fn entity_count(&self) -> usize {
    self
      .layers
      .iter()
      .map(|layer| layer.timed.entities.len())
      .fold(0usize, usize::saturating_add)
  }

  pub(super) fn entities(
    &self,
    detector: StaticDetectorId,
  ) -> &[PipelineEntity] {
    &self.detector_entities(detector).entities
  }

  pub(super) fn detector_entities(
    &self,
    detector: StaticDetectorId,
  ) -> &TimedEntities {
    self
      .layers
      .iter()
      .find(|layer| layer.detector == detector)
      .map_or(&EMPTY_TIMED_ENTITIES, |layer| &layer.timed)
  }

  pub(super) fn set_detector_entities(
    &mut self,
    detector: StaticDetectorId,
    entities: TimedEntities,
  ) {
    if let Some(layer) = self
      .layers
      .iter_mut()
      .find(|layer| layer.detector == detector)
    {
      layer.timed = entities;
      return;
    }
    self.layers.push(DetectorEntityPass {
      detector,
      timed: entities,
    });
  }

  pub(super) fn into_layers(self) -> Vec<DetectorEntityPass> {
    self.layers
  }
}

pub(super) fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}
