//! Portable, model-neutral external detection exchange contract.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::caller::{
  BindingCallerDetection, BindingCallerDetectionRequest,
  CALLER_DETECTION_CONTRACT_VERSION, caller_detections_from_binding,
};
use crate::error::{ContractError, Result};
use crate::offsets::{CharacterOffsetMap, Utf16OffsetMap};

pub const EXTERNAL_DETECTION_BATCH_VERSION: u32 = 1;
pub const EXTERNAL_DETECTION_BATCH_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const EXTERNAL_DETECTION_MAX_DETECTIONS: usize = 100_000;
const EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS: usize = 4_096;
const EXTERNAL_DETECTION_MAX_METADATA_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalDetectionOffsetUnit {
  Utf8Byte,
  Utf16CodeUnit,
  UnicodeCodePoint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDetectionDocument {
  pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDetectionProvider {
  pub id: String,
  pub name: String,
  pub version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDetectionLabelMapping {
  pub provider_label: String,
  pub entity_label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDetection {
  pub id: String,
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub score: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDetectionBatch {
  pub version: u32,
  pub document: ExternalDetectionDocument,
  pub offset_unit: ExternalDetectionOffsetUnit,
  pub provider: ExternalDetectionProvider,
  pub label_map: Vec<ExternalDetectionLabelMapping>,
  pub detections: Vec<ExternalDetection>,
}

/// Validates an exchange batch against the exact supplied bytes and converts
/// its spans to the core caller-detection contract's UTF-8 byte offsets.
pub fn external_detection_batch_to_caller_request(
  document_bytes: &[u8],
  batch_json: &str,
) -> Result<BindingCallerDetectionRequest> {
  if document_bytes.len() > EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES {
    return Err(invalid("document exceeds byte limit"));
  }
  if batch_json.len() > EXTERNAL_DETECTION_BATCH_MAX_BYTES {
    return Err(invalid("batch exceeds byte limit"));
  }
  let full_text = std::str::from_utf8(document_bytes)
    .map_err(|_| invalid("document is not valid UTF-8"))?;
  let batch: ExternalDetectionBatch = serde_json::from_str(batch_json)
    .map_err(|error| invalid(format!("JSON contract: {error}")))?;
  if batch.version != EXTERNAL_DETECTION_BATCH_VERSION {
    return Err(invalid(format!(
      "unsupported version {}; expected {EXTERNAL_DETECTION_BATCH_VERSION}",
      batch.version
    )));
  }
  validate_batch_metadata(document_bytes, &batch)?;
  let label_map = label_map_from(batch.label_map)?;
  let detections = convert_detections(
    full_text,
    batch.offset_unit,
    &batch.provider.id,
    &label_map,
    batch.detections,
  )?;
  let request = BindingCallerDetectionRequest {
    version: CALLER_DETECTION_CONTRACT_VERSION,
    detections,
  };
  caller_detections_from_binding(request.clone())?;
  Ok(request)
}

fn validate_batch_metadata(
  document_bytes: &[u8],
  batch: &ExternalDetectionBatch,
) -> Result<()> {
  validate_digest(document_bytes, &batch.document.sha256)?;
  validate_provider_id(&batch.provider.id)?;
  validate_metadata(
    "provider.name",
    &batch.provider.name,
    EXTERNAL_DETECTION_MAX_METADATA_BYTES,
  )?;
  validate_metadata(
    "provider.version",
    &batch.provider.version,
    EXTERNAL_DETECTION_MAX_METADATA_BYTES,
  )?;
  if batch.label_map.len() > EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS {
    return Err(invalid("labelMap exceeds entry limit"));
  }
  if batch.detections.len() > EXTERNAL_DETECTION_MAX_DETECTIONS {
    return Err(invalid("detections exceeds entry limit"));
  }
  Ok(())
}

fn label_map_from(
  mappings: Vec<ExternalDetectionLabelMapping>,
) -> Result<BTreeMap<String, String>> {
  let mut label_map = BTreeMap::new();
  for mapping in mappings {
    validate_metadata(
      "labelMap.providerLabel",
      &mapping.provider_label,
      EXTERNAL_DETECTION_MAX_METADATA_BYTES,
    )?;
    validate_metadata(
      "labelMap.entityLabel",
      &mapping.entity_label,
      EXTERNAL_DETECTION_MAX_METADATA_BYTES,
    )?;
    if label_map
      .insert(mapping.provider_label, mapping.entity_label)
      .is_some()
    {
      return Err(invalid("labelMap contains a duplicate providerLabel"));
    }
  }
  Ok(label_map)
}

fn convert_detections(
  full_text: &str,
  offset_unit: ExternalDetectionOffsetUnit,
  provider_id: &str,
  label_map: &BTreeMap<String, String>,
  external_detections: Vec<ExternalDetection>,
) -> Result<Vec<BindingCallerDetection>> {
  let utf16_offsets = match offset_unit {
    ExternalDetectionOffsetUnit::Utf16CodeUnit => {
      Some(Utf16OffsetMap::new(full_text)?)
    }
    _ => None,
  };
  let character_offsets = match offset_unit {
    ExternalDetectionOffsetUnit::UnicodeCodePoint => {
      Some(CharacterOffsetMap::new(full_text)?)
    }
    _ => None,
  };
  let mut provenance = BTreeSet::new();
  let mut detections = Vec::with_capacity(external_detections.len());
  for (index, detection) in external_detections.into_iter().enumerate() {
    if !provenance.insert(detection.id.clone()) {
      return Err(invalid(format!(
        "detections[{index}].id duplicates provider provenance"
      )));
    }
    let label = label_map.get(&detection.label).cloned().ok_or_else(|| {
      invalid(format!("detections[{index}].label has no labelMap entry"))
    })?;
    let (start, end) = convert_offsets(
      offset_unit,
      detection.start,
      detection.end,
      utf16_offsets.as_ref(),
      character_offsets.as_ref(),
      index,
    )?;
    if start >= end {
      return Err(invalid(format!(
        "detections[{index}] span start must be less than end"
      )));
    }
    let start_usize = usize::try_from(start)
      .map_err(|_| invalid(format!("detections[{index}] start is invalid")))?;
    let end_usize = usize::try_from(end)
      .map_err(|_| invalid(format!("detections[{index}] end is invalid")))?;
    if full_text.get(start_usize..end_usize).is_none() {
      return Err(invalid(format!(
        "detections[{index}] span is outside the document or not on UTF-8 boundaries"
      )));
    }
    detections.push(BindingCallerDetection {
      start,
      end,
      label,
      score: detection.score,
      provider_id: provider_id.to_owned(),
      detection_id: detection.id,
    });
  }
  Ok(detections)
}

pub fn external_detection_batch_to_caller_request_json(
  document_bytes: &[u8],
  batch_json: &str,
) -> Result<String> {
  let request =
    external_detection_batch_to_caller_request(document_bytes, batch_json)?;
  serde_json::to_string(&request)
    .map_err(|error| invalid(format!("converted request: {error}")))
}

/// Converts a portable batch into the UTF-16 offsets expected by JavaScript
/// caller-detection APIs.
pub fn external_detection_batch_to_utf16_caller_request(
  document_bytes: &[u8],
  batch_json: &str,
) -> Result<BindingCallerDetectionRequest> {
  let full_text = document_text(document_bytes)?;
  let mut request =
    external_detection_batch_to_caller_request(document_bytes, batch_json)?;
  let offsets = Utf16OffsetMap::new(full_text)?;
  convert_request_offsets(&mut request, |offset| offsets.convert(offset))?;
  Ok(request)
}

/// Converts a portable batch into Unicode code-point offsets, which are the
/// offsets expected by Python string APIs.
pub fn external_detection_batch_to_character_caller_request_json(
  document_bytes: &[u8],
  batch_json: &str,
) -> Result<String> {
  let request = external_detection_batch_to_character_caller_request(
    document_bytes,
    batch_json,
  )?;
  serialize_request(&request)
}

pub fn external_detection_batch_to_character_caller_request(
  document_bytes: &[u8],
  batch_json: &str,
) -> Result<BindingCallerDetectionRequest> {
  let full_text = document_text(document_bytes)?;
  let mut request =
    external_detection_batch_to_caller_request(document_bytes, batch_json)?;
  let offsets = CharacterOffsetMap::new(full_text)?;
  convert_request_offsets(&mut request, |offset| offsets.convert(offset))?;
  Ok(request)
}

fn convert_request_offsets(
  request: &mut BindingCallerDetectionRequest,
  convert: impl Fn(u32) -> Result<u32>,
) -> Result<()> {
  for (index, detection) in request.detections.iter_mut().enumerate() {
    detection.start = convert(detection.start).map_err(|error| {
      invalid(format!("converted detections[{index}].start: {error}"))
    })?;
    detection.end = convert(detection.end).map_err(|error| {
      invalid(format!("converted detections[{index}].end: {error}"))
    })?;
  }
  Ok(())
}

fn document_text(document_bytes: &[u8]) -> Result<&str> {
  std::str::from_utf8(document_bytes)
    .map_err(|_| invalid("document is not valid UTF-8"))
}

fn serialize_request(
  request: &BindingCallerDetectionRequest,
) -> Result<String> {
  serde_json::to_string(request)
    .map_err(|error| invalid(format!("converted request: {error}")))
}

fn convert_offsets(
  unit: ExternalDetectionOffsetUnit,
  start: u32,
  end: u32,
  utf16_offsets: Option<&Utf16OffsetMap>,
  character_offsets: Option<&CharacterOffsetMap>,
  index: usize,
) -> Result<(u32, u32)> {
  let convert = |offset| match unit {
    ExternalDetectionOffsetUnit::Utf8Byte => Ok(offset),
    ExternalDetectionOffsetUnit::Utf16CodeUnit => utf16_offsets
      .ok_or_else(|| invalid("UTF-16 offset map is unavailable"))?
      .byte_offset(offset),
    ExternalDetectionOffsetUnit::UnicodeCodePoint => character_offsets
      .ok_or_else(|| invalid("character offset map is unavailable"))?
      .byte_offset(offset),
  };
  let start = convert(start)
    .map_err(|error| invalid(format!("detections[{index}].start: {error}")))?;
  let end = convert(end)
    .map_err(|error| invalid(format!("detections[{index}].end: {error}")))?;
  Ok((start, end))
}

fn validate_digest(document_bytes: &[u8], expected: &str) -> Result<()> {
  if expected.len() != 64
    || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    || expected.bytes().any(|byte| byte.is_ascii_uppercase())
  {
    return Err(invalid(
      "document.sha256 must be 64 lowercase hexadecimal characters",
    ));
  }
  let actual = Sha256::digest(document_bytes);
  let matches = expected.as_bytes().chunks_exact(2).zip(actual.iter()).all(
    |(pair, actual_byte)| {
      let high = pair.first().and_then(|byte| hex_nibble(*byte));
      let low = pair.get(1).and_then(|byte| hex_nibble(*byte));
      high
        .zip(low)
        .is_some_and(|(high, low)| (high << 4) | low == *actual_byte)
    },
  );
  if !matches {
    return Err(invalid("document.sha256 does not match input bytes"));
  }
  Ok(())
}

fn hex_nibble(byte: u8) -> Option<u8> {
  match byte {
    b'0'..=b'9' => byte.checked_sub(b'0'),
    b'a'..=b'f' => byte
      .checked_sub(b'a')
      .and_then(|value| value.checked_add(10)),
    _ => None,
  }
}

fn validate_metadata(
  field: &'static str,
  value: &str,
  max_bytes: usize,
) -> Result<()> {
  if value.trim().is_empty() || value.len() > max_bytes {
    return Err(invalid(format!(
      "{field} must be non-blank and at most {max_bytes} bytes"
    )));
  }
  Ok(())
}

fn validate_provider_id(value: &str) -> Result<()> {
  if value.is_empty() || value.len() > 128 {
    return Err(invalid("provider.id has an invalid length"));
  }
  let mut bytes = value.bytes();
  let valid_first = bytes
    .next()
    .is_some_and(|byte| byte.is_ascii_alphanumeric());
  let valid_rest = bytes.all(|byte| {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
  });
  if !valid_first || !valid_rest {
    return Err(invalid("provider.id has invalid characters"));
  }
  Ok(())
}

fn invalid(reason: impl Into<String>) -> ContractError {
  ContractError::InvalidExternalDetectionBatch {
    reason: reason.into(),
  }
}

#[cfg(test)]
mod tests {
  #![allow(clippy::indexing_slicing, clippy::unwrap_used)]

  use serde_json::{Value, json};

  use super::{
    EXTERNAL_DETECTION_BATCH_MAX_BYTES, ExternalDetectionOffsetUnit,
    external_detection_batch_to_caller_request,
    external_detection_batch_to_character_caller_request_json,
    external_detection_batch_to_utf16_caller_request,
  };

  const DOCUMENT: &[u8] = "😀Alice signed.".as_bytes();
  const FIXTURE: &str =
    include_str!("../tests/fixtures/external-detection-batch-v1.json");

  #[test]
  fn shared_fixture_converts_code_points_to_utf8_bytes() {
    let request =
      external_detection_batch_to_caller_request(DOCUMENT, FIXTURE).unwrap();
    assert_eq!(request.detections.len(), 1);
    assert_eq!(request.detections[0].start, 4);
    assert_eq!(request.detections[0].end, 9);
    assert_eq!(request.detections[0].label, "person");
    assert_eq!(request.detections[0].provider_id, "example.local");
  }

  #[test]
  fn shared_fixture_converts_to_each_host_language_offset_unit() {
    let js =
      external_detection_batch_to_utf16_caller_request(DOCUMENT, FIXTURE)
        .unwrap();
    let python = external_detection_batch_to_character_caller_request_json(
      DOCUMENT, FIXTURE,
    )
    .unwrap();
    let js = serde_json::to_value(js).unwrap();
    let python: Value = serde_json::from_str(&python).unwrap();
    assert_eq!(js["detections"][0]["start"], 2);
    assert_eq!(js["detections"][0]["end"], 7);
    assert_eq!(python["detections"][0]["start"], 1);
    assert_eq!(python["detections"][0]["end"], 6);
  }

  #[test]
  fn contract_rejects_stale_unknown_and_duplicate_inputs() {
    let cases = [
      mutate(|batch| batch["version"] = json!(2)),
      mutate(|batch| batch["document"]["sha256"] = json!("0".repeat(64))),
      mutate(|batch| batch["unknown"] = json!(true)),
      mutate(|batch| batch["provider"]["unknown"] = json!(true)),
      mutate(|batch| batch["detections"][0]["unknown"] = json!(true)),
      mutate(|batch| {
        batch["provider"]["id"] = json!("invalid provider");
        batch["detections"] = json!([]);
      }),
      mutate(|batch| {
        let duplicate = batch["detections"][0].clone();
        batch["detections"].as_array_mut().unwrap().push(duplicate);
      }),
      mutate(|batch| batch["detections"][0]["label"] = json!("UNKNOWN")),
    ];
    for batch in cases {
      assert!(
        external_detection_batch_to_caller_request(
          DOCUMENT,
          &serde_json::to_string(&batch).unwrap(),
        )
        .is_err()
      );
    }
  }

  #[test]
  fn contract_rejects_oversized_json_before_parsing() {
    let oversized =
      " ".repeat(EXTERNAL_DETECTION_BATCH_MAX_BYTES.saturating_add(1));
    assert!(
      external_detection_batch_to_caller_request(DOCUMENT, &oversized).is_err()
    );
  }

  #[test]
  fn every_offset_unit_rejects_invalid_boundaries() {
    let cases = [
      (ExternalDetectionOffsetUnit::Utf8Byte, 1_u32, 9_u32),
      (ExternalDetectionOffsetUnit::Utf16CodeUnit, 1, 7),
      (ExternalDetectionOffsetUnit::UnicodeCodePoint, 1, 99),
    ];
    for (unit, start, end) in cases {
      let batch = mutate(|batch| {
        batch["offsetUnit"] = serde_json::to_value(unit).unwrap();
        batch["detections"][0]["start"] = json!(start);
        batch["detections"][0]["end"] = json!(end);
      });
      assert!(
        external_detection_batch_to_caller_request(
          DOCUMENT,
          &serde_json::to_string(&batch).unwrap(),
        )
        .is_err()
      );
    }
  }

  fn mutate(update: impl FnOnce(&mut Value)) -> Value {
    let mut batch = serde_json::from_str(FIXTURE).unwrap();
    update(&mut batch);
    batch
  }
}
