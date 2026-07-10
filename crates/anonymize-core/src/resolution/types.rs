use crate::types::EntityKind;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetectionSource {
  Caller,
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
      Self::Caller | Self::Ner => 1,
    }
  }
}

/// A caller-supplied entity span using UTF-8 byte offsets.
///
/// The matched text is intentionally not accepted from the caller. It is
/// derived from the document when the detection enters the pipeline.
#[derive(Clone, Debug, PartialEq)]
pub struct CallerDetection {
  start: u32,
  end: u32,
  label: String,
  score: f64,
  provenance: CallerProvenance,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallerDetectionParams {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub score: f64,
  pub provider_id: String,
  pub detection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallerProvenance {
  provider_id: String,
  detection_id: String,
}

impl CallerProvenance {
  #[must_use]
  pub fn provider_id(&self) -> &str {
    &self.provider_id
  }

  #[must_use]
  pub fn detection_id(&self) -> &str {
    &self.detection_id
  }
}

impl CallerDetection {
  pub fn new(params: CallerDetectionParams) -> crate::types::Result<Self> {
    let CallerDetectionParams {
      start,
      end,
      label,
      score,
      provider_id,
      detection_id,
    } = params;
    if start >= end {
      return Err(crate::types::Error::InvalidCallerDetection {
        field: "span",
        reason: format!("start {start} must be less than end {end}"),
      });
    }
    if label.trim().is_empty() {
      return Err(crate::types::Error::InvalidCallerDetection {
        field: "label",
        reason: String::from("must not be blank"),
      });
    }
    if !score.is_finite() || !(0.0..=1.0).contains(&score) {
      return Err(crate::types::Error::InvalidCallerDetection {
        field: "score",
        reason: String::from("must be finite and between 0 and 1"),
      });
    }
    validate_provenance_id("provider_id", &provider_id)?;
    validate_provenance_id("detection_id", &detection_id)?;
    Ok(Self {
      start,
      end,
      label,
      score,
      provenance: CallerProvenance {
        provider_id,
        detection_id,
      },
    })
  }

  #[must_use]
  pub const fn provenance(&self) -> &CallerProvenance {
    &self.provenance
  }

  pub(crate) fn into_pipeline_entity(
    self,
    full_text: &str,
  ) -> crate::types::Result<PipelineEntity> {
    let text = crate::byte_offsets::ByteOffsets::new(full_text)
      .slice(self.start, self.end)?;
    let mut entity = PipelineEntity::detected(
      self.start,
      self.end,
      self.label,
      text,
      self.score,
      DetectionSource::Caller,
    );
    entity.caller_provenance = Some(self.provenance);
    Ok(entity)
  }
}

fn validate_provenance_id(
  field: &'static str,
  value: &str,
) -> crate::types::Result<()> {
  const MAX_PROVENANCE_ID_BYTES: usize = 128;
  if value.is_empty() || value.len() > MAX_PROVENANCE_ID_BYTES {
    return Err(invalid_provenance_id(field));
  }
  let mut bytes = value.bytes();
  let valid_first = bytes
    .next()
    .is_some_and(|byte| byte.is_ascii_alphanumeric());
  let valid_rest = bytes.all(|byte| {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
  });
  if valid_first && valid_rest {
    return Ok(());
  }
  Err(invalid_provenance_id(field))
}

fn invalid_provenance_id(field: &'static str) -> crate::types::Error {
  crate::types::Error::InvalidCallerDetection {
    field,
    reason: String::from(
      "must be 1-128 ASCII characters: alphanumeric first, then alphanumeric, '.', '_', ':', or '-'",
    ),
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
  pub caller_provenance: Option<CallerProvenance>,
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
      caller_provenance: None,
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
      caller_provenance: None,
      kind: EntityKind::Coreference {
        source_text: source_text.into(),
      },
    }
  }
}
