use crate::types::EntityKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetectionSource {
  Trigger,
  Regex,
  DenyList,
  LegalForm,
  Gazetteer,
  Country,
  Ner,
  Coreference,
}

impl DetectionSource {
  pub(crate) const fn priority(self) -> u8 {
    match self {
      Self::Gazetteer => 5,
      Self::Trigger => 4,
      Self::LegalForm | Self::Regex | Self::Country => 3,
      Self::DenyList | Self::Coreference => 2,
      Self::Ner => 1,
    }
  }
}

#[derive(
  Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub enum SourceDetail {
  CustomDenyList,
  CustomRegex,
  GazetteerExtension,
  AddressContext,
}

/// Internal pipeline entity span. `start` and `end` are UTF-8 byte offsets.
#[derive(Clone, Debug, PartialEq)]
pub struct PipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: DetectionSource,
  pub source_detail: Option<SourceDetail>,
  pub kind: EntityKind,
}

impl PipelineEntity {
  #[must_use]
  pub fn detected(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    score: f64,
    source: DetectionSource,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      score,
      source,
      source_detail: None,
      kind: EntityKind::Detected,
    }
  }

  #[must_use]
  pub fn coreference(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    score: f64,
    source_text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      score,
      source: DetectionSource::Coreference,
      source_detail: None,
      kind: EntityKind::Coreference {
        source_text: source_text.into(),
      },
    }
  }
}
