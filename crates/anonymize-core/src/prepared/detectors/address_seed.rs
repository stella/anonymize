use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_registry::{
  StaticDetector, StaticDetectorContext, StaticDetectorId, StaticDetectorInput,
  StaticEntityDetector,
};
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timed_entities;

pub(in crate::prepared) struct AddressSeedDetector;

impl StaticEntityDetector for AddressSeedDetector {
  fn spec(&self) -> StaticDetector {
    StaticDetector::new(
      StaticDetectorId::AddressSeed,
      DiagnosticStage::EntityAddressSeed,
      &[
        StaticDetectorInput::LiteralMatches,
        StaticDetectorInput::AddressSeedData,
        StaticDetectorInput::ContextEntities,
      ],
      &[
        StaticDetectorId::Regex,
        StaticDetectorId::CustomRegex,
        StaticDetectorId::Anchored,
        StaticDetectorId::Trigger,
        StaticDetectorId::Signature,
        StaticDetectorId::LegalForm,
        StaticDetectorId::DenyList,
        StaticDetectorId::Gazetteer,
        StaticDetectorId::NameCorpus,
      ],
    )
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
      let spec = self.spec();
      let existing_entities = address_seed_context(spec.dependencies(), passes);
      data.process(
        &context.matches.literal,
        context.engine.policy.slices.street_types,
        context.full_text,
        &existing_entities,
      )
    })
  }
}

fn address_seed_context(
  dependencies: &[StaticDetectorId],
  passes: &StaticEntityPasses,
) -> Vec<PipelineEntity> {
  let capacity = dependencies
    .iter()
    .map(|detector_id| passes.entities(*detector_id).len())
    .fold(0usize, usize::saturating_add);
  let mut entities = Vec::with_capacity(capacity);
  for detector_id in dependencies {
    entities.extend(passes.entities(*detector_id).iter().cloned());
  }
  entities
}
