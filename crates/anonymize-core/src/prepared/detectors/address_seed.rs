use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct AddressSeedDetector;

impl StaticEntityDetector for AddressSeedDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::by_id(StaticDetectorId::AddressSeed)
  }

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    passes: &StaticEntityPasses,
  ) -> Result<TimedEntities> {
    timed_entities(|| {
      let Some(data) = &context.engine.data.address_seed else {
        return Ok(Vec::new());
      };
      let existing_entities = address_seed_context(&[
        &passes.regex.entities,
        &passes.custom_regex.entities,
        &passes.anchored.entities,
        &passes.trigger.entities,
        &passes.signature.entities,
        &passes.legal_form.entities,
        &passes.deny_list.entities,
        &passes.gazetteer.entities,
        &passes.name_corpus.entities,
      ]);
      data.process(
        &context.matches.literal,
        context.engine.policy.slices.street_types,
        context.full_text,
        &existing_entities,
      )
    })
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
