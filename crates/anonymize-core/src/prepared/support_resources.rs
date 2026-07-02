use crate::diagnostics::DiagnosticStage;

use super::detector_contract::StaticDetectorInput;

macro_rules! support_resources {
  (
    $(
      $variant:ident {
        config_field: $config_field:literal,
        detector_input: $detector_input:expr,
        stage: $stage:expr,
      }
    ),+ $(,)?
  ) => {
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum SupportResourceId {
      $($variant),+
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) struct SupportResourceSpec {
      id: SupportResourceId,
      config_field: &'static str,
      detector_input: Option<StaticDetectorInput>,
      stage: DiagnosticStage,
    }

    impl SupportResourceSpec {
      const fn new(
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

      pub(super) const fn detector_input(
        self,
      ) -> Option<StaticDetectorInput> {
        self.detector_input
      }

      pub(super) const fn diagnostic_stage(self) -> DiagnosticStage {
        self.stage
      }
    }

    impl SupportResourceId {
      pub(super) const ORDER: &'static [Self] = &[$(Self::$variant),+];

      pub(super) const fn spec(self) -> SupportResourceSpec {
        match self {
          $(
            Self::$variant => SupportResourceSpec::new(
              Self::$variant,
              $config_field,
              $detector_input,
              $stage,
            ),
          )+
        }
      }
    }
  };
}

support_resources! {
  Hotwords {
    config_field: "hotword_data",
    detector_input: None,
    stage: DiagnosticStage::PrepareHotwordData,
  },
  Triggers {
    config_field: "trigger_data",
    detector_input: Some(StaticDetectorInput::TriggerData),
    stage: DiagnosticStage::PrepareTriggerData,
  },
  LegalForms {
    config_field: "legal_form_data",
    detector_input: Some(StaticDetectorInput::LegalFormData),
    stage: DiagnosticStage::PrepareLegalFormData,
  },
  AddressSeed {
    config_field: "address_seed_data",
    detector_input: Some(StaticDetectorInput::AddressSeedData),
    stage: DiagnosticStage::PrepareAddressSeedData,
  },
  Zones {
    config_field: "zone_data",
    detector_input: None,
    stage: DiagnosticStage::PrepareZoneData,
  },
  AddressContext {
    config_field: "address_context_data",
    detector_input: None,
    stage: DiagnosticStage::PrepareAddressContextData,
  },
  Coreference {
    config_field: "coreference_data",
    detector_input: None,
    stage: DiagnosticStage::PrepareCoreferenceData,
  },
  NameCorpus {
    config_field: "name_corpus_data",
    detector_input: Some(StaticDetectorInput::NameCorpusData),
    stage: DiagnosticStage::PrepareNameCorpusData,
  },
  Signature {
    config_field: "signature_data",
    detector_input: Some(StaticDetectorInput::SignatureData),
    stage: DiagnosticStage::PrepareSignatureData,
  },
}

#[cfg(test)]
mod tests {
  use super::SupportResourceId;

  #[derive(serde::Serialize)]
  struct SupportResourcesSnapshot {
    resources: Vec<SupportResourceSnapshot>,
  }

  #[derive(serde::Serialize)]
  struct SupportResourceSnapshot {
    id: String,
    config_field: &'static str,
    detector_input: Option<String>,
    stage: String,
  }

  #[test]
  fn support_resources_declare_unique_metadata() {
    let mut ids = Vec::new();
    let mut fields = Vec::new();
    let mut detector_inputs = Vec::new();
    let mut stages = Vec::new();
    for resource_id in SupportResourceId::ORDER.iter().copied() {
      let resource = resource_id.spec();
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
        resource,
        "support resource id must map to its declared spec",
      );
    }
  }

  #[test]
  fn support_resources_snapshot() {
    insta::assert_yaml_snapshot!(
      "support_resources",
      support_resources_snapshot_data()
    );
  }

  fn support_resources_snapshot_data() -> SupportResourcesSnapshot {
    SupportResourcesSnapshot {
      resources: SupportResourceId::ORDER
        .iter()
        .copied()
        .map(|resource_id| {
          let resource = resource_id.spec();
          SupportResourceSnapshot {
            id: format!("{:?}", resource.id()),
            config_field: resource.config_field(),
            detector_input: resource
              .detector_input()
              .map(|input| format!("{input:?}")),
            stage: format!("{:?}", resource.diagnostic_stage()),
          }
        })
        .collect(),
    }
  }
}
