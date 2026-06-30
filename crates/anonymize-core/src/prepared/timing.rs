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
  pub(super) const fn empty() -> Self {
    Self {
      regex: TimedEntities::empty(),
      custom_regex: TimedEntities::empty(),
      deny_list: TimedEntities::empty(),
      gazetteer: TimedEntities::empty(),
      country: TimedEntities::empty(),
      anchored: TimedEntities::empty(),
      trigger: TimedEntities::empty(),
      signature: TimedEntities::empty(),
      legal_form: TimedEntities::empty(),
      address_seed: TimedEntities::empty(),
      name_corpus: TimedEntities::empty(),
    }
  }

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

  pub(super) const fn detector_entities(
    &self,
    detector: StaticDetectorId,
  ) -> &TimedEntities {
    match detector {
      StaticDetectorId::Regex => &self.regex,
      StaticDetectorId::CustomRegex => &self.custom_regex,
      StaticDetectorId::DenyList => &self.deny_list,
      StaticDetectorId::Gazetteer => &self.gazetteer,
      StaticDetectorId::Country => &self.country,
      StaticDetectorId::Anchored => &self.anchored,
      StaticDetectorId::Trigger => &self.trigger,
      StaticDetectorId::Signature => &self.signature,
      StaticDetectorId::LegalForm => &self.legal_form,
      StaticDetectorId::NameCorpus => &self.name_corpus,
      StaticDetectorId::AddressSeed => &self.address_seed,
    }
  }

  pub(super) fn set_detector_entities(
    &mut self,
    detector: StaticDetectorId,
    entities: TimedEntities,
  ) {
    match detector {
      StaticDetectorId::Regex => self.regex = entities,
      StaticDetectorId::CustomRegex => self.custom_regex = entities,
      StaticDetectorId::DenyList => self.deny_list = entities,
      StaticDetectorId::Gazetteer => self.gazetteer = entities,
      StaticDetectorId::Country => self.country = entities,
      StaticDetectorId::Anchored => self.anchored = entities,
      StaticDetectorId::Trigger => self.trigger = entities,
      StaticDetectorId::Signature => self.signature = entities,
      StaticDetectorId::LegalForm => self.legal_form = entities,
      StaticDetectorId::NameCorpus => self.name_corpus = entities,
      StaticDetectorId::AddressSeed => self.address_seed = entities,
    }
  }
}

pub(super) fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}
