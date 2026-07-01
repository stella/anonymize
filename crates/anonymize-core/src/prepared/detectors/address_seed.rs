use crate::diagnostics::DiagnosticStage;
use crate::prepared::detector_contract::{
  StaticDetectorContext, StaticDetectorDiagnostics, StaticDetectorId,
  StaticDetectorInput, StaticDetectorRule, StaticDetectorSpec,
};
use crate::prepared::support_resources::SupportResourceId;
use crate::prepared::timing::{StaticEntityPasses, TimedEntities};
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timed_entities;

const ADDRESS_SEED_DEPENDENCIES: &[StaticDetectorId] = &[
  StaticDetectorId::Regex,
  StaticDetectorId::CustomRegex,
  StaticDetectorId::Anchored,
  StaticDetectorId::Trigger,
  StaticDetectorId::Signature,
  StaticDetectorId::LegalForm,
  StaticDetectorId::DenyList,
  StaticDetectorId::Gazetteer,
  StaticDetectorId::NameCorpus,
];

pub(in crate::prepared) const ADDRESS_SEED_RULE: StaticDetectorRule =
  StaticDetectorRule::declare(
    StaticDetectorSpec::define(
      StaticDetectorId::AddressSeed,
      DiagnosticStage::EntityAddressSeed,
    )
    .requires(&[
      StaticDetectorInput::LiteralMatches,
      StaticDetectorInput::AddressSeedData,
      StaticDetectorInput::ContextEntities,
    ])
    .after(ADDRESS_SEED_DEPENDENCIES)
    .uses(&[SupportResourceId::AddressSeed]),
    detect_address_seed,
  );

fn detect_address_seed(
  context: &StaticDetectorContext<'_>,
  passes: &StaticEntityPasses,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let engine = context.engine;
  let matches = context.matches;
  let full_text = context.full_text;
  timed_entities(|| {
    let Some(data) = &engine.data.address_seed else {
      return Ok(Vec::new());
    };
    let existing_entities =
      address_seed_context(ADDRESS_SEED_RULE.spec().dependencies(), passes);
    data.process(
      &matches.literal,
      engine.policy.slices.street_types,
      full_text,
      &existing_entities,
    )
  })
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
