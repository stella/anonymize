use std::time::Instant;

use crate::resolution::PipelineEntity;
use crate::types::SearchMatch;

use super::detector_contract::StaticDetectorId;

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
  layers: [Option<TimedEntities>; StaticDetectorId::COUNT],
}

impl StaticEntityPasses {
  pub(super) fn new() -> Self {
    Self {
      layers: std::array::from_fn(|_| None),
    }
  }

  pub(super) fn entity_count(&self) -> usize {
    self
      .layers
      .iter()
      .filter_map(Option::as_ref)
      .map(|timed| timed.entities.len())
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
      .get(detector.index())
      .and_then(Option::as_ref)
      .unwrap_or(&EMPTY_TIMED_ENTITIES)
  }

  pub(super) fn push_detector_entities(
    &mut self,
    detector: StaticDetectorId,
    entities: TimedEntities,
  ) {
    let Some(slot) = self.layers.get_mut(detector.index()) else {
      debug_assert!(false, "static detector index must be in bounds");
      return;
    };
    debug_assert!(slot.is_none(), "static detector passes are append-only");
    *slot = Some(entities);
  }

  pub(super) fn into_layers(self) -> Vec<DetectorEntityPass> {
    let mut layers = Vec::with_capacity(StaticDetectorId::COUNT);
    for (detector, timed) in
      StaticDetectorId::ORDER.into_iter().zip(self.layers)
    {
      let Some(timed) = timed else {
        continue;
      };
      layers.push(DetectorEntityPass { detector, timed });
    }
    layers
  }
}

pub(super) fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}
