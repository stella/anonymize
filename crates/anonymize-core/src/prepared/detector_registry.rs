use crate::diagnostics::DiagnosticStage;
use crate::diagnostics::StaticRedactionDiagnostics;
use crate::types::Result;

use super::PreparedEngine;
use super::detectors::{
  ADDRESS_SEED_RULE, ANCHORED_RULE, COUNTRY_RULE, CUSTOM_REGEX_RULE,
  DENY_LIST_RULE, GAZETTEER_RULE, LEGAL_FORM_RULE, NAME_CORPUS_RULE,
  REGEX_RULE, SIGNATURE_RULE, TRIGGER_RULE,
};
use super::results::PreparedEngineMatches;
use super::timing::{StaticEntityPasses, TimedEntities};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorId {
  Regex,
  CustomRegex,
  DenyList,
  Gazetteer,
  Country,
  Anchored,
  Trigger,
  Signature,
  LegalForm,
  NameCorpus,
  AddressSeed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StaticDetectorInput {
  FullText,
  RegexMatches,
  CustomRegexMatches,
  LiteralMatches,
  RegexMeta,
  CustomRegexMeta,
  DenyListData,
  GazetteerData,
  CountryData,
  DateData,
  MonetaryData,
  TriggerData,
  SignatureData,
  LegalFormData,
  NameCorpusData,
  AddressSeedData,
  ContextEntities,
  DenyListEntities,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct StaticDetectorSpec {
  id: StaticDetectorId,
  stage: DiagnosticStage,
  required_inputs: &'static [StaticDetectorInput],
  dependencies: &'static [StaticDetectorId],
}

impl StaticDetectorSpec {
  pub(super) const fn new(
    id: StaticDetectorId,
    stage: DiagnosticStage,
    required_inputs: &'static [StaticDetectorInput],
    dependencies: &'static [StaticDetectorId],
  ) -> Self {
    Self {
      id,
      stage,
      required_inputs,
      dependencies,
    }
  }

  pub(super) const fn id(self) -> StaticDetectorId {
    self.id
  }

  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
    self.stage
  }

  pub(super) const fn required_inputs(self) -> &'static [StaticDetectorInput] {
    self.required_inputs
  }

  pub(super) const fn dependencies(self) -> &'static [StaticDetectorId] {
    self.dependencies
  }
}

pub(super) struct StaticDetectorContext<'a> {
  pub(super) engine: &'a PreparedEngine,
  pub(super) matches: &'a PreparedEngineMatches,
  pub(super) full_text: &'a str,
}

pub(super) type StaticDetectorDiagnostics<'d> =
  Option<&'d mut StaticRedactionDiagnostics>;

pub(super) type StaticDetectFn = for<'a, 'p, 'd> fn(
  &StaticDetectorContext<'a>,
  &'p StaticEntityPasses,
  StaticDetectorDiagnostics<'d>,
) -> Result<TimedEntities>;

#[derive(Clone, Copy)]
pub(super) struct StaticDetectorRule {
  spec: StaticDetectorSpec,
  detect: StaticDetectFn,
}

impl StaticDetectorRule {
  pub(super) const fn new(
    spec: StaticDetectorSpec,
    detect: StaticDetectFn,
  ) -> Self {
    Self { spec, detect }
  }

  pub(super) const fn spec(self) -> StaticDetectorSpec {
    self.spec
  }

  pub(super) fn detect(
    self,
    context: &StaticDetectorContext<'_>,
    passes: &StaticEntityPasses,
    diagnostics: StaticDetectorDiagnostics<'_>,
  ) -> Result<TimedEntities> {
    (self.detect)(context, passes, diagnostics)
  }
}

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
  use super::{STATIC_ENTITY_RULES, StaticDetectorId};

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
        !metadata.required_inputs().is_empty(),
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
