use crate::diagnostics::DiagnosticStage;

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
}

pub(super) const STATIC_DETECTORS: &[StaticDetector] = &[
  StaticDetector::new(
    StaticDetectorId::Regex,
    DiagnosticStage::EntityRegex,
    &[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::FullText,
      StaticDetectorInput::RegexMeta,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::CustomRegex,
    DiagnosticStage::EntityCustomRegex,
    &[
      StaticDetectorInput::CustomRegexMatches,
      StaticDetectorInput::FullText,
      StaticDetectorInput::CustomRegexMeta,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::DenyList,
    DiagnosticStage::EntityDenyList,
    &[
      StaticDetectorInput::LiteralMatches,
      StaticDetectorInput::DenyListData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::Gazetteer,
    DiagnosticStage::EntityGazetteer,
    &[
      StaticDetectorInput::LiteralMatches,
      StaticDetectorInput::GazetteerData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::Country,
    DiagnosticStage::EntityCountry,
    &[
      StaticDetectorInput::LiteralMatches,
      StaticDetectorInput::CountryData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::Anchored,
    DiagnosticStage::EntityAnchored,
    &[
      StaticDetectorInput::FullText,
      StaticDetectorInput::DateData,
      StaticDetectorInput::MonetaryData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::Trigger,
    DiagnosticStage::EntityTrigger,
    &[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::TriggerData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::Signature,
    DiagnosticStage::EntitySignature,
    &[
      StaticDetectorInput::FullText,
      StaticDetectorInput::SignatureData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::LegalForm,
    DiagnosticStage::EntityLegalForm,
    &[
      StaticDetectorInput::RegexMatches,
      StaticDetectorInput::LegalFormData,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::NameCorpus,
    DiagnosticStage::EntityNameCorpus,
    &[
      StaticDetectorInput::FullText,
      StaticDetectorInput::NameCorpusData,
      StaticDetectorInput::DenyListEntities,
    ],
  ),
  StaticDetector::new(
    StaticDetectorId::AddressSeed,
    DiagnosticStage::EntityAddressSeed,
    &[
      StaticDetectorInput::LiteralMatches,
      StaticDetectorInput::AddressSeedData,
      StaticDetectorInput::ContextEntities,
    ],
  ),
];
