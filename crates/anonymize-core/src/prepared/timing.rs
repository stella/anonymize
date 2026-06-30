use std::time::Instant;

use crate::resolution::PipelineEntity;
use crate::types::SearchMatch;

pub(super) struct TimedEntities {
  pub(super) entities: Vec<PipelineEntity>,
  pub(super) elapsed_us: u64,
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
  pub(super) regex: TimedEntities,
  pub(super) custom_regex: TimedEntities,
  pub(super) deny_list: TimedEntities,
  pub(super) gazetteer: TimedEntities,
  pub(super) country: TimedEntities,
  pub(super) anchored: TimedEntities,
  pub(super) trigger: TimedEntities,
  pub(super) signature: TimedEntities,
  pub(super) legal_form: TimedEntities,
  pub(super) address_seed: TimedEntities,
  pub(super) name_corpus: TimedEntities,
}

impl StaticEntityPasses {
  pub(super) const fn entity_count(&self) -> usize {
    self
      .regex
      .entities
      .len()
      .saturating_add(self.custom_regex.entities.len())
      .saturating_add(self.deny_list.entities.len())
      .saturating_add(self.gazetteer.entities.len())
      .saturating_add(self.country.entities.len())
      .saturating_add(self.anchored.entities.len())
      .saturating_add(self.trigger.entities.len())
      .saturating_add(self.signature.entities.len())
      .saturating_add(self.legal_form.entities.len())
      .saturating_add(self.address_seed.entities.len())
      .saturating_add(self.name_corpus.entities.len())
  }
}

pub(super) fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}
