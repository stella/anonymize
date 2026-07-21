//! Portable, model-neutral external detection exchange contract.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::caller::{
  BindingCallerDetection, BindingCallerDetectionRequest,
  CALLER_DETECTION_CONTRACT_VERSION, caller_detections_from_binding,
};
use crate::error::{ContractError, Result};

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
  let requested_offsets = external_detections
    .iter()
    .flat_map(|detection| [detection.start, detection.end])
    .collect::<Vec<_>>();
  let byte_offsets = convert_offset_set(
    full_text,
    &requested_offsets,
    offset_unit,
    ExternalDetectionOffsetUnit::Utf8Byte,
  )?;
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
    let start =
      converted_offset(&byte_offsets, detection.start, index, "start")?;
    let end = converted_offset(&byte_offsets, detection.end, index, "end")?;
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
  convert_request_offsets(
    full_text,
    &mut request,
    ExternalDetectionOffsetUnit::Utf16CodeUnit,
  )?;
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
  convert_request_offsets(
    full_text,
    &mut request,
    ExternalDetectionOffsetUnit::UnicodeCodePoint,
  )?;
  Ok(request)
}

fn convert_request_offsets(
  full_text: &str,
  request: &mut BindingCallerDetectionRequest,
  output_unit: ExternalDetectionOffsetUnit,
) -> Result<()> {
  let requested_offsets = request
    .detections
    .iter()
    .flat_map(|detection| [detection.start, detection.end])
    .collect::<Vec<_>>();
  let converted = convert_offset_set(
    full_text,
    &requested_offsets,
    ExternalDetectionOffsetUnit::Utf8Byte,
    output_unit,
  )?;
  for (index, detection) in request.detections.iter_mut().enumerate() {
    detection.start =
      converted_offset(&converted, detection.start, index, "start")?;
    detection.end = converted_offset(&converted, detection.end, index, "end")?;
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

fn convert_offset_set(
  full_text: &str,
  requested_offsets: &[u32],
  input_unit: ExternalDetectionOffsetUnit,
  output_unit: ExternalDetectionOffsetUnit,
) -> Result<BTreeMap<u32, u32>> {
  let mut requested = requested_offsets.to_vec();
  requested.sort_unstable();
  requested.dedup();
  let mut converted = BTreeMap::new();
  if requested.is_empty() {
    return Ok(converted);
  }
  let mut requested_index = 0_usize;
  record_requested_boundary(
    &requested,
    &mut requested_index,
    &mut converted,
    BoundaryOffsets::default(),
    input_unit,
    output_unit,
  )?;
  if requested_index == requested.len() {
    return Ok(converted);
  }

  let mut boundary = BoundaryOffsets::default();
  for (byte_start, character) in full_text.char_indices() {
    let byte_end = byte_start
      .checked_add(character.len_utf8())
      .and_then(|value| u32::try_from(value).ok())
      .ok_or_else(|| invalid("document byte offset exceeds u32 range"))?;
    boundary = BoundaryOffsets {
      utf8_byte: byte_end,
      utf16_code_unit: boundary
        .utf16_code_unit
        .checked_add(
          u32::try_from(character.len_utf16())
            .map_err(|_| invalid("UTF-16 character width exceeds u32 range"))?,
        )
        .ok_or_else(|| invalid("UTF-16 offset exceeds u32 range"))?,
      unicode_code_point: boundary
        .unicode_code_point
        .checked_add(1)
        .ok_or_else(|| invalid("character offset exceeds u32 range"))?,
    };
    record_requested_boundary(
      &requested,
      &mut requested_index,
      &mut converted,
      boundary,
      input_unit,
      output_unit,
    )?;
    if requested_index == requested.len() {
      break;
    }
  }
  if requested_index != requested.len() {
    return Err(invalid(
      "offset is outside the document or not on a boundary",
    ));
  }
  Ok(converted)
}

#[derive(Clone, Copy, Default)]
struct BoundaryOffsets {
  utf8_byte: u32,
  utf16_code_unit: u32,
  unicode_code_point: u32,
}

impl BoundaryOffsets {
  const fn get(self, unit: ExternalDetectionOffsetUnit) -> u32 {
    match unit {
      ExternalDetectionOffsetUnit::Utf8Byte => self.utf8_byte,
      ExternalDetectionOffsetUnit::Utf16CodeUnit => self.utf16_code_unit,
      ExternalDetectionOffsetUnit::UnicodeCodePoint => self.unicode_code_point,
    }
  }
}

fn record_requested_boundary(
  requested: &[u32],
  requested_index: &mut usize,
  converted: &mut BTreeMap<u32, u32>,
  boundary: BoundaryOffsets,
  input_unit: ExternalDetectionOffsetUnit,
  output_unit: ExternalDetectionOffsetUnit,
) -> Result<()> {
  let input_offset = boundary.get(input_unit);
  while requested.get(*requested_index).copied() == Some(input_offset) {
    converted.insert(input_offset, boundary.get(output_unit));
    *requested_index = (*requested_index)
      .checked_add(1)
      .ok_or_else(|| invalid("requested offset index exceeds usize range"))?;
  }
  if requested
    .get(*requested_index)
    .is_some_and(|requested_offset| *requested_offset < input_offset)
  {
    return Err(invalid("offset is not on a valid text boundary"));
  }
  Ok(())
}

fn converted_offset(
  converted: &BTreeMap<u32, u32>,
  offset: u32,
  index: usize,
  field: &'static str,
) -> Result<u32> {
  converted.get(&offset).copied().ok_or_else(|| {
    invalid(format!(
      "detections[{index}].{field} could not be converted"
    ))
  })
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
  if value.trim().is_empty()
    || value.len() > max_bytes
    || value.chars().any(char::is_control)
  {
    return Err(invalid(format!(
      "{field} must be non-blank, control-free, and at most {max_bytes} bytes"
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
    convert_offset_set, external_detection_batch_to_caller_request,
    external_detection_batch_to_character_caller_request,
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
  fn every_source_offset_unit_converts_the_same_span_across_hosts() {
    let cases = [
      (ExternalDetectionOffsetUnit::Utf8Byte, 4_u32, 9_u32),
      (ExternalDetectionOffsetUnit::Utf16CodeUnit, 2, 7),
      (ExternalDetectionOffsetUnit::UnicodeCodePoint, 1, 6),
    ];
    for (unit, start, end) in cases {
      let batch = mutate(|batch| {
        batch["offsetUnit"] = serde_json::to_value(unit).unwrap();
        batch["detections"][0]["start"] = json!(start);
        batch["detections"][0]["end"] = json!(end);
      });
      let batch_json = serde_json::to_string(&batch).unwrap();
      let core =
        external_detection_batch_to_caller_request(DOCUMENT, &batch_json)
          .unwrap();
      let node =
        external_detection_batch_to_utf16_caller_request(DOCUMENT, &batch_json)
          .unwrap();
      let python = external_detection_batch_to_character_caller_request(
        DOCUMENT,
        &batch_json,
      )
      .unwrap();

      assert_eq!(core.detections[0].start, 4);
      assert_eq!(core.detections[0].end, 9);
      assert_eq!(node.detections[0].start, 2);
      assert_eq!(node.detections[0].end, 7);
      assert_eq!(python.detections[0].start, 1);
      assert_eq!(python.detections[0].end, 6);
    }
  }

  #[test]
  fn large_ascii_conversion_uses_memory_bounded_by_requested_offsets() {
    let text = "a".repeat(1_000_000);
    let converted = convert_offset_set(
      &text,
      &[0, 1_000_000],
      ExternalDetectionOffsetUnit::UnicodeCodePoint,
      ExternalDetectionOffsetUnit::Utf8Byte,
    )
    .unwrap();
    assert_eq!(converted.len(), 2);
    assert_eq!(converted.get(&0), Some(&0));
    assert_eq!(converted.get(&1_000_000), Some(&1_000_000));
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
      mutate(|batch| batch["provider"]["name"] = json!("unsafe\nname")),
      mutate(|batch| {
        batch["labelMap"][0]["entityLabel"] = json!("person\u{0007}");
      }),
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
