use std::time::Instant;

use crate::prepared::detector_contract::StaticDetectorRule;
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timing::{TimedEntities, elapsed_us};

mod prelude;

// New detector modules own their rule metadata and expose a `RULES` slice.
// This module only fixes cross-module execution order.
macro_rules! static_detectors {
  (
    $(
      mod $module:ident;
    )+
  ) => {
    $(mod $module;)+

    const STATIC_ENTITY_RULE_GROUPS: &[&[StaticDetectorRule]] = &[
      $($module::RULES),+
    ];
  };
}

static_detectors! {
  mod regex;
  mod literal;
  mod anchored;
  mod trigger;
  mod signature;
  mod legal_form;
  mod name_corpus;
  mod address_seed;
}

pub(super) fn static_entity_rules() -> impl Iterator<Item = StaticDetectorRule>
{
  STATIC_ENTITY_RULE_GROUPS
    .iter()
    .flat_map(|rules| rules.iter().copied())
}

fn timed_entities<F>(detect: F) -> Result<TimedEntities>
where
  F: FnOnce() -> Result<Vec<PipelineEntity>>,
{
  let start = Instant::now();
  let entities = detect()?;
  Ok(TimedEntities {
    entities,
    elapsed_us: elapsed_us(start),
  })
}

#[cfg(test)]
mod tests {
  use super::static_entity_rules;
  use crate::prepared::detector_contract::StaticDetectorId;

  #[test]
  fn detector_registry_entries_declare_metadata() {
    let mut ids = Vec::new();
    let mut stages = Vec::new();
    for rule in static_entity_rules() {
      let metadata = rule.spec();
      assert!(
        !ids.contains(&metadata.id()),
        "detector ids must be unique: {:?}",
        metadata.id(),
      );
      assert!(
        !stages.contains(&metadata.diagnostic_stage()),
        "detector diagnostic stages must be unique: {:?}",
        metadata.diagnostic_stage(),
      );
      assert!(
        metadata.has_declared_inputs(),
        "detectors must declare their required inputs",
      );
      let mut dependencies = Vec::new();
      for dependency in metadata.dependencies() {
        assert_ne!(
          metadata.id(),
          *dependency,
          "detectors must not depend on themselves",
        );
        assert!(
          !dependencies.contains(dependency),
          "detector dependencies must be unique: {dependency:?}",
        );
        dependencies.push(*dependency);
        assert!(
          detector_exists(*dependency),
          "detector dependency must be registered: {dependency:?}",
        );
      }
      let mut support_resources = Vec::new();
      for resource in metadata.support_resources() {
        let resource_spec = resource.spec();
        assert!(
          !support_resources.contains(resource),
          "detector support resources must be unique: {resource:?}",
        );
        support_resources.push(*resource);
        let detector_input = resource_spec.detector_input();
        assert!(
          detector_input.is_some(),
          "detector support resource must expose a detector input",
        );
        if let Some(input) = detector_input {
          assert!(
            metadata.declares_input(input),
            "detector support resource input must be derived: {input:?}",
          );
          assert!(
            !metadata.declared_inputs().contains(&input),
            "detector support resource input must not be duplicated: {input:?}",
          );
        }
      }
      ids.push(metadata.id());
      stages.push(metadata.diagnostic_stage());
    }
  }

  #[test]
  fn dependent_detectors_run_after_their_context_sources() {
    for rule in static_entity_rules() {
      let metadata = rule.spec();
      let id = metadata.id();
      for dependency in metadata.dependencies() {
        assert!(
          runs_after(id, *dependency),
          "detector {id:?} must run after dependency {dependency:?}",
        );
      }
    }
  }

  fn runs_after(
    detector: StaticDetectorId,
    dependency: StaticDetectorId,
  ) -> bool {
    match (position_of(detector), position_of(dependency)) {
      (Some(detector_index), Some(dependency_index)) => {
        detector_index > dependency_index
      }
      _ => false,
    }
  }

  fn position_of(detector_id: StaticDetectorId) -> Option<usize> {
    static_entity_rules().position(|rule| rule.spec().id() == detector_id)
  }

  fn detector_exists(detector_id: StaticDetectorId) -> bool {
    static_entity_rules().any(|rule| rule.spec().id() == detector_id)
  }
}
