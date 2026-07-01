use super::prelude::*;
use super::timed_entities;

const ADDRESS_SEED_DEPENDENCIES: &[DetectorId] = &[
  DetectorId::Regex,
  DetectorId::CustomRegex,
  DetectorId::Anchored,
  DetectorId::Trigger,
  DetectorId::Signature,
  DetectorId::LegalForm,
  DetectorId::DenyList,
  DetectorId::Gazetteer,
  DetectorId::NameCorpus,
];

static_detector_rule! {
  pub(in crate::prepared) const ADDRESS_SEED_RULE;
  id: DetectorId::AddressSeed;
  inputs: &[
    DetectorInput::LiteralMatches,
    DetectorInput::ContextEntities,
  ];
  after: ADDRESS_SEED_DEPENDENCIES;
  uses: &[SupportResource::AddressSeed];
  detect: detect_address_seed;
}

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
  dependencies: &[DetectorId],
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
