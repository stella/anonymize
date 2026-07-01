use crate::diagnostics::DiagnosticStage;
use crate::diagnostics::StaticRedactionDiagnostics;
use crate::types::Result;

use super::PreparedEngine;
use super::detectors::{
  AddressSeedDetector, AnchoredDetector, CountryDetector, CustomRegexDetector,
  DenyListDetector, GazetteerDetector, LegalFormDetector, NameCorpusDetector,
  RegexDetector, SignatureDetector, TriggerDetector,
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

pub(super) struct StaticDetectorContext<'a, 'd> {
  pub(super) engine: &'a PreparedEngine,
  pub(super) matches: &'a PreparedEngineMatches,
  pub(super) full_text: &'a str,
  pub(super) diagnostics: Option<&'d mut StaticRedactionDiagnostics>,
}

pub(super) trait StaticEntityDetector: Sync {
  fn spec(&self) -> StaticDetectorSpec;

  fn detect(
    &self,
    context: StaticDetectorContext<'_, '_>,
    passes: &StaticEntityPasses,
  ) -> Result<TimedEntities>;
}

static REGEX_DETECTOR: RegexDetector = RegexDetector;
static CUSTOM_REGEX_DETECTOR: CustomRegexDetector = CustomRegexDetector;
static DENY_LIST_DETECTOR: DenyListDetector = DenyListDetector;
static GAZETTEER_DETECTOR: GazetteerDetector = GazetteerDetector;
static COUNTRY_DETECTOR: CountryDetector = CountryDetector;
static ANCHORED_DETECTOR: AnchoredDetector = AnchoredDetector;
static TRIGGER_DETECTOR: TriggerDetector = TriggerDetector;
static SIGNATURE_DETECTOR: SignatureDetector = SignatureDetector;
static LEGAL_FORM_DETECTOR: LegalFormDetector = LegalFormDetector;
static NAME_CORPUS_DETECTOR: NameCorpusDetector = NameCorpusDetector;
static ADDRESS_SEED_DETECTOR: AddressSeedDetector = AddressSeedDetector;

pub(super) static STATIC_ENTITY_DETECTORS: &[&dyn StaticEntityDetector] = &[
  &REGEX_DETECTOR,
  &CUSTOM_REGEX_DETECTOR,
  &DENY_LIST_DETECTOR,
  &GAZETTEER_DETECTOR,
  &COUNTRY_DETECTOR,
  &ANCHORED_DETECTOR,
  &TRIGGER_DETECTOR,
  &SIGNATURE_DETECTOR,
  &LEGAL_FORM_DETECTOR,
  &NAME_CORPUS_DETECTOR,
  &ADDRESS_SEED_DETECTOR,
];

#[cfg(test)]
mod tests {
  use super::{STATIC_ENTITY_DETECTORS, StaticDetectorId};

  #[test]
  fn detector_registry_entries_declare_metadata() {
    let mut ids = Vec::new();
    let mut stages = Vec::new();
    for detector in STATIC_ENTITY_DETECTORS {
      let metadata = detector.spec();
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
    for detector in STATIC_ENTITY_DETECTORS {
      let metadata = detector.spec();
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
    STATIC_ENTITY_DETECTORS
      .iter()
      .position(|detector| detector.spec().id() == detector_id)
  }

  fn detector_exists(detector_id: StaticDetectorId) -> bool {
    STATIC_ENTITY_DETECTORS
      .iter()
      .any(|detector| detector.spec().id() == detector_id)
  }
}
