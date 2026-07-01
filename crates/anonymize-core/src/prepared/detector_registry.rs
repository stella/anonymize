use super::detector_contract::StaticDetectorRule;
use super::detectors::{
  ADDRESS_SEED_RULE, ANCHORED_RULE, COUNTRY_RULE, CUSTOM_REGEX_RULE,
  DENY_LIST_RULE, GAZETTEER_RULE, LEGAL_FORM_RULE, NAME_CORPUS_RULE,
  REGEX_RULE, SIGNATURE_RULE, TRIGGER_RULE,
};

pub(super) static STATIC_ENTITY_RULES: &[StaticDetectorRule] = &[
  REGEX_RULE,
  CUSTOM_REGEX_RULE,
  DENY_LIST_RULE,
  GAZETTEER_RULE,
  COUNTRY_RULE,
  ANCHORED_RULE,
  TRIGGER_RULE,
  SIGNATURE_RULE,
  LEGAL_FORM_RULE,
  NAME_CORPUS_RULE,
  ADDRESS_SEED_RULE,
];

#[cfg(test)]
mod tests {
  use super::STATIC_ENTITY_RULES;
  use crate::prepared::detector_contract::StaticDetectorId;

  #[test]
  fn detector_registry_entries_declare_metadata() {
    let mut ids = Vec::new();
    let mut stages = Vec::new();
    for rule in STATIC_ENTITY_RULES {
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
    for rule in STATIC_ENTITY_RULES {
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
    STATIC_ENTITY_RULES
      .iter()
      .position(|rule| rule.spec().id() == detector_id)
  }

  fn detector_exists(detector_id: StaticDetectorId) -> bool {
    STATIC_ENTITY_RULES
      .iter()
      .any(|rule| rule.spec().id() == detector_id)
  }
}
