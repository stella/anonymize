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
pub(super) struct StaticDetector {
  id: StaticDetectorId,
  stage: DiagnosticStage,
  required_inputs: &'static [StaticDetectorInput],
}

impl StaticDetector {
  const fn new(
    id: StaticDetectorId,
    stage: DiagnosticStage,
    required_inputs: &'static [StaticDetectorInput],
  ) -> Self {
    Self {
      id,
      stage,
      required_inputs,
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

  pub(super) const fn by_id(id: StaticDetectorId) -> Self {
    match id {
      StaticDetectorId::Regex => Self::new(
        StaticDetectorId::Regex,
        DiagnosticStage::EntityRegex,
        &[
          StaticDetectorInput::RegexMatches,
          StaticDetectorInput::FullText,
          StaticDetectorInput::RegexMeta,
        ],
      ),
      StaticDetectorId::CustomRegex => Self::new(
        StaticDetectorId::CustomRegex,
        DiagnosticStage::EntityCustomRegex,
        &[
          StaticDetectorInput::CustomRegexMatches,
          StaticDetectorInput::FullText,
          StaticDetectorInput::CustomRegexMeta,
        ],
      ),
      StaticDetectorId::DenyList => Self::new(
        StaticDetectorId::DenyList,
        DiagnosticStage::EntityDenyList,
        &[
          StaticDetectorInput::LiteralMatches,
          StaticDetectorInput::DenyListData,
        ],
      ),
      StaticDetectorId::Gazetteer => Self::new(
        StaticDetectorId::Gazetteer,
        DiagnosticStage::EntityGazetteer,
        &[
          StaticDetectorInput::LiteralMatches,
          StaticDetectorInput::GazetteerData,
        ],
      ),
      StaticDetectorId::Country => Self::new(
        StaticDetectorId::Country,
        DiagnosticStage::EntityCountry,
        &[
          StaticDetectorInput::LiteralMatches,
          StaticDetectorInput::CountryData,
        ],
      ),
      StaticDetectorId::Anchored => Self::new(
        StaticDetectorId::Anchored,
        DiagnosticStage::EntityAnchored,
        &[
          StaticDetectorInput::FullText,
          StaticDetectorInput::DateData,
          StaticDetectorInput::MonetaryData,
        ],
      ),
      StaticDetectorId::Trigger => Self::new(
        StaticDetectorId::Trigger,
        DiagnosticStage::EntityTrigger,
        &[
          StaticDetectorInput::RegexMatches,
          StaticDetectorInput::TriggerData,
        ],
      ),
      StaticDetectorId::Signature => Self::new(
        StaticDetectorId::Signature,
        DiagnosticStage::EntitySignature,
        &[
          StaticDetectorInput::FullText,
          StaticDetectorInput::SignatureData,
        ],
      ),
      StaticDetectorId::LegalForm => Self::new(
        StaticDetectorId::LegalForm,
        DiagnosticStage::EntityLegalForm,
        &[
          StaticDetectorInput::RegexMatches,
          StaticDetectorInput::LegalFormData,
        ],
      ),
      StaticDetectorId::NameCorpus => Self::new(
        StaticDetectorId::NameCorpus,
        DiagnosticStage::EntityNameCorpus,
        &[
          StaticDetectorInput::FullText,
          StaticDetectorInput::NameCorpusData,
          StaticDetectorInput::DenyListEntities,
        ],
      ),
      StaticDetectorId::AddressSeed => Self::new(
        StaticDetectorId::AddressSeed,
        DiagnosticStage::EntityAddressSeed,
        &[
          StaticDetectorInput::LiteralMatches,
          StaticDetectorInput::AddressSeedData,
          StaticDetectorInput::ContextEntities,
        ],
      ),
    }
  }
}

pub(super) struct StaticDetectorContext<'a, 'd> {
  pub(super) engine: &'a PreparedEngine,
  pub(super) matches: &'a PreparedEngineMatches,
  pub(super) full_text: &'a str,
  pub(super) diagnostics: Option<&'d mut StaticRedactionDiagnostics>,
}

pub(super) trait StaticEntityDetector: Sync {
  fn spec(&self) -> StaticDetector;

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

pub(super) const STATIC_DETECTORS: &[StaticDetector] = &[
  StaticDetector::by_id(StaticDetectorId::Regex),
  StaticDetector::by_id(StaticDetectorId::CustomRegex),
  StaticDetector::by_id(StaticDetectorId::DenyList),
  StaticDetector::by_id(StaticDetectorId::Gazetteer),
  StaticDetector::by_id(StaticDetectorId::Country),
  StaticDetector::by_id(StaticDetectorId::Anchored),
  StaticDetector::by_id(StaticDetectorId::Trigger),
  StaticDetector::by_id(StaticDetectorId::Signature),
  StaticDetector::by_id(StaticDetectorId::LegalForm),
  StaticDetector::by_id(StaticDetectorId::NameCorpus),
  StaticDetector::by_id(StaticDetectorId::AddressSeed),
];

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
  use super::{STATIC_DETECTORS, STATIC_ENTITY_DETECTORS, StaticDetectorId};

  #[test]
  fn detector_metadata_matches_runtime_registry_order() {
    assert_eq!(
      STATIC_DETECTORS.len(),
      STATIC_ENTITY_DETECTORS.len(),
      "detector metadata and runtime registry must stay aligned",
    );

    for (metadata, detector) in STATIC_DETECTORS
      .iter()
      .copied()
      .zip(STATIC_ENTITY_DETECTORS.iter().copied())
    {
      assert_eq!(
        metadata,
        detector.spec(),
        "detector metadata must match the runtime implementation order",
      );
      assert!(
        !metadata.required_inputs().is_empty(),
        "detectors must declare their required inputs",
      );
    }
  }

  #[test]
  fn dependent_detectors_run_after_their_context_sources() {
    assert!(
      runs_after(StaticDetectorId::NameCorpus, StaticDetectorId::DenyList),
      "name corpus depends on deny-list entities",
    );
    for dependency in [
      StaticDetectorId::Regex,
      StaticDetectorId::CustomRegex,
      StaticDetectorId::Anchored,
      StaticDetectorId::Trigger,
      StaticDetectorId::Signature,
      StaticDetectorId::LegalForm,
      StaticDetectorId::DenyList,
      StaticDetectorId::Gazetteer,
      StaticDetectorId::NameCorpus,
    ] {
      assert!(
        runs_after(StaticDetectorId::AddressSeed, dependency),
        "address seed depends on earlier context entities",
      );
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
}
