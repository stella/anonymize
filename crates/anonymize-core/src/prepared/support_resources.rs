use crate::diagnostics::DiagnosticStage;

use super::detector_contract::StaticDetectorInput;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SupportResourceId {
  Hotwords,
  Triggers,
  LegalForms,
  AddressSeed,
  Zones,
  AddressContext,
  Coreference,
  NameCorpus,
  Signature,
}

impl SupportResourceId {
  pub(super) const fn spec(self) -> SupportResourceSpec {
    match self {
      Self::Hotwords => HOTWORD_RESOURCE,
      Self::Triggers => TRIGGER_RESOURCE,
      Self::LegalForms => LEGAL_FORM_RESOURCE,
      Self::AddressSeed => ADDRESS_SEED_RESOURCE,
      Self::Zones => ZONE_RESOURCE,
      Self::AddressContext => ADDRESS_CONTEXT_RESOURCE,
      Self::Coreference => COREFERENCE_RESOURCE,
      Self::NameCorpus => NAME_CORPUS_RESOURCE,
      Self::Signature => SIGNATURE_RESOURCE,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SupportResourceSpec {
  id: SupportResourceId,
  config_field: &'static str,
  detector_input: Option<StaticDetectorInput>,
  stage: DiagnosticStage,
}

impl SupportResourceSpec {
  pub(super) const fn new(
    id: SupportResourceId,
    config_field: &'static str,
    detector_input: Option<StaticDetectorInput>,
    stage: DiagnosticStage,
  ) -> Self {
    Self {
      id,
      config_field,
      detector_input,
      stage,
    }
  }

  pub(super) const fn id(self) -> SupportResourceId {
    self.id
  }

  pub(super) const fn config_field(self) -> &'static str {
    self.config_field
  }

  pub(super) const fn detector_input(self) -> Option<StaticDetectorInput> {
    self.detector_input
  }

  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
    self.stage
  }
}

pub(super) const HOTWORD_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Hotwords,
    "hotword_data",
    None,
    DiagnosticStage::PrepareHotwordData,
  );

pub(super) const TRIGGER_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Triggers,
    "trigger_data",
    Some(StaticDetectorInput::TriggerData),
    DiagnosticStage::PrepareTriggerData,
  );

pub(super) const LEGAL_FORM_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::LegalForms,
    "legal_form_data",
    Some(StaticDetectorInput::LegalFormData),
    DiagnosticStage::PrepareLegalFormData,
  );

pub(super) const ADDRESS_SEED_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::AddressSeed,
    "address_seed_data",
    Some(StaticDetectorInput::AddressSeedData),
    DiagnosticStage::PrepareAddressSeedData,
  );

pub(super) const ZONE_RESOURCE: SupportResourceSpec = SupportResourceSpec::new(
  SupportResourceId::Zones,
  "zone_data",
  None,
  DiagnosticStage::PrepareZoneData,
);

pub(super) const ADDRESS_CONTEXT_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::AddressContext,
    "address_context_data",
    None,
    DiagnosticStage::PrepareAddressContextData,
  );

pub(super) const COREFERENCE_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Coreference,
    "coreference_data",
    None,
    DiagnosticStage::PrepareCoreferenceData,
  );

pub(super) const NAME_CORPUS_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::NameCorpus,
    "name_corpus_data",
    Some(StaticDetectorInput::NameCorpusData),
    DiagnosticStage::PrepareNameCorpusData,
  );

pub(super) const SIGNATURE_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Signature,
    "signature_data",
    Some(StaticDetectorInput::SignatureData),
    DiagnosticStage::PrepareSignatureData,
  );

#[cfg(test)]
const SUPPORT_RESOURCES: &[SupportResourceSpec] = &[
  HOTWORD_RESOURCE,
  TRIGGER_RESOURCE,
  LEGAL_FORM_RESOURCE,
  ADDRESS_SEED_RESOURCE,
  ZONE_RESOURCE,
  ADDRESS_CONTEXT_RESOURCE,
  COREFERENCE_RESOURCE,
  NAME_CORPUS_RESOURCE,
  SIGNATURE_RESOURCE,
];

#[cfg(test)]
mod tests {
  use super::SUPPORT_RESOURCES;

  #[test]
  fn support_resources_declare_unique_metadata() {
    let mut ids = Vec::new();
    let mut fields = Vec::new();
    let mut detector_inputs = Vec::new();
    let mut stages = Vec::new();
    for resource in SUPPORT_RESOURCES {
      assert!(
        !ids.contains(&resource.id()),
        "support resource ids must be unique: {:?}",
        resource.id(),
      );
      assert!(
        !fields.contains(&resource.config_field()),
        "support resource fields must be unique: {}",
        resource.config_field(),
      );
      if let Some(input) = resource.detector_input() {
        assert!(
          !detector_inputs.contains(&input),
          "support resource detector inputs must be unique: {input:?}",
        );
        detector_inputs.push(input);
      }
      assert!(
        !stages.contains(&resource.diagnostic_stage()),
        "support resource stages must be unique: {:?}",
        resource.diagnostic_stage(),
      );
      ids.push(resource.id());
      fields.push(resource.config_field());
      stages.push(resource.diagnostic_stage());
      assert_eq!(
        resource.id().spec(),
        *resource,
        "support resource id must map to its declared spec",
      );
    }
  }
}
