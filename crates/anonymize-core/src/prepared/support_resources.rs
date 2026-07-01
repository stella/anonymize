use crate::diagnostics::DiagnosticStage;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct SupportResourceSpec {
  id: SupportResourceId,
  field: &'static str,
  stage: DiagnosticStage,
}

impl SupportResourceSpec {
  pub(super) const fn new(
    id: SupportResourceId,
    field: &'static str,
    stage: DiagnosticStage,
  ) -> Self {
    Self { id, field, stage }
  }

  pub(super) const fn id(self) -> SupportResourceId {
    self.id
  }

  pub(super) const fn field(self) -> &'static str {
    self.field
  }

  pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
    self.stage
  }
}

pub(super) const HOTWORD_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Hotwords,
    "hotword_data",
    DiagnosticStage::PrepareHotwordData,
  );

pub(super) const TRIGGER_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Triggers,
    "trigger_data",
    DiagnosticStage::PrepareTriggerData,
  );

pub(super) const LEGAL_FORM_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::LegalForms,
    "legal_form_data",
    DiagnosticStage::PrepareLegalFormData,
  );

pub(super) const ADDRESS_SEED_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::AddressSeed,
    "address_seed_data",
    DiagnosticStage::PrepareAddressSeedData,
  );

pub(super) const ZONE_RESOURCE: SupportResourceSpec = SupportResourceSpec::new(
  SupportResourceId::Zones,
  "zone_data",
  DiagnosticStage::PrepareZoneData,
);

pub(super) const ADDRESS_CONTEXT_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::AddressContext,
    "address_context_data",
    DiagnosticStage::PrepareAddressContextData,
  );

pub(super) const COREFERENCE_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Coreference,
    "coreference_data",
    DiagnosticStage::PrepareCoreferenceData,
  );

pub(super) const NAME_CORPUS_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::NameCorpus,
    "name_corpus_data",
    DiagnosticStage::PrepareNameCorpusData,
  );

pub(super) const SIGNATURE_RESOURCE: SupportResourceSpec =
  SupportResourceSpec::new(
    SupportResourceId::Signature,
    "signature_data",
    DiagnosticStage::PrepareSignatureData,
  );

pub(super) const SUPPORT_RESOURCES: &[SupportResourceSpec] = &[
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

pub(super) fn support_resource_exists(resource_id: SupportResourceId) -> bool {
  SUPPORT_RESOURCES
    .iter()
    .any(|resource| resource.id() == resource_id)
}

#[cfg(test)]
mod tests {
  use super::SUPPORT_RESOURCES;

  #[test]
  fn support_resources_declare_unique_metadata() {
    let mut ids = Vec::new();
    let mut fields = Vec::new();
    let mut stages = Vec::new();
    for resource in SUPPORT_RESOURCES {
      assert!(
        !ids.contains(&resource.id()),
        "support resource ids must be unique: {:?}",
        resource.id(),
      );
      assert!(
        !fields.contains(&resource.field()),
        "support resource fields must be unique: {}",
        resource.field(),
      );
      assert!(
        !stages.contains(&resource.diagnostic_stage()),
        "support resource stages must be unique: {:?}",
        resource.diagnostic_stage(),
      );
      ids.push(resource.id());
      fields.push(resource.field());
      stages.push(resource.diagnostic_stage());
    }
  }
}
