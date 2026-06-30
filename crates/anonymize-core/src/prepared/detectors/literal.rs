use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::processors::{
  process_country_matches, process_deny_list_matches, process_gazetteer_matches,
};
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct DenyListDetector;

impl StaticEntityDetector for DenyListDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::DenyList)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.deny_list else {
        return Ok(Vec::new());
      };
      process_deny_list_matches(
        &context.matches.literal,
        context.engine.policy.slices.deny_list,
        context.full_text,
        data,
      )
    })
  }
}

pub(in crate::prepared) struct GazetteerDetector;

impl StaticEntityDetector for GazetteerDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::Gazetteer)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.gazetteer else {
        return Ok(Vec::new());
      };
      process_gazetteer_matches(
        &context.matches.literal,
        context.engine.policy.slices.gazetteer,
        context.full_text,
        data,
      )
    })
  }
}

pub(in crate::prepared) struct CountryDetector;

impl StaticEntityDetector for CountryDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::Country)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    _passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.countries else {
        return Ok(Vec::new());
      };
      process_country_matches(
        &context.matches.literal,
        context.engine.policy.slices.countries,
        context.full_text,
        data,
      )
    })
  }
}
