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
pub const EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS: usize = 4_096;
pub const EXTERNAL_DETECTION_MAX_METADATA_BYTES: usize = 256;
pub const EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDetectionLimits {
  pub batch_max_bytes: usize,
  pub document_max_bytes: usize,
  pub max_detections: usize,
  pub max_label_mappings: usize,
  pub max_metadata_bytes: usize,
  pub provider_id_max_bytes: usize,
}

pub const EXTERNAL_DETECTION_LIMITS: ExternalDetectionLimits =
  ExternalDetectionLimits {
    batch_max_bytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
    document_max_bytes: EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
    max_detections: EXTERNAL_DETECTION_MAX_DETECTIONS,
    max_label_mappings: EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
    max_metadata_bytes: EXTERNAL_DETECTION_MAX_METADATA_BYTES,
    provider_id_max_bytes: EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
  };

pub fn external_detection_limits_json() -> Result<String> {
  serde_json::to_string(&EXTERNAL_DETECTION_LIMITS)
    .map_err(|error| invalid(format!("limits: {error}")))
}

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
  convert_external_detection_batch(
    document_bytes,
    batch_json,
    ExternalDetectionOffsetUnit::Utf8Byte,
  )
}

fn convert_external_detection_batch(
  document_bytes: &[u8],
  batch_json: &str,
  output_unit: ExternalDetectionOffsetUnit,
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
  let (detections, coordinate_spans) = convert_detections(
    full_text,
    batch.offset_unit,
    &batch.provider.id,
    &label_map,
    &batch.detections,
  )?;
  let mut request = BindingCallerDetectionRequest {
    version: CALLER_DETECTION_CONTRACT_VERSION,
    detections,
  };
  caller_detections_from_binding(request.clone())?;
  if output_unit != ExternalDetectionOffsetUnit::Utf8Byte {
    for (detection, (start, end)) in
      request.detections.iter_mut().zip(coordinate_spans)
    {
      detection.start = start.get(output_unit);
      detection.end = end.get(output_unit);
    }
  }
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
  external_detections: &[ExternalDetection],
) -> Result<ConvertedDetections> {
  let requested_offsets = external_detections
    .iter()
    .flat_map(|detection| [detection.start, detection.end])
    .collect::<Vec<_>>();
  let coordinates =
    resolve_requested_boundaries(full_text, &requested_offsets, offset_unit)?;
  let mut provenance = BTreeSet::new();
  let mut detections = Vec::with_capacity(external_detections.len());
  let mut coordinate_spans = Vec::with_capacity(external_detections.len());
  for (index, detection) in external_detections.iter().enumerate() {
    if !provenance.insert(detection.id.clone()) {
      return Err(invalid(format!(
        "detections[{index}].id duplicates provider provenance"
      )));
    }
    let label = label_map.get(&detection.label).cloned().ok_or_else(|| {
      invalid(format!("detections[{index}].label has no labelMap entry"))
    })?;
    let start_coordinates =
      coordinates.get(&detection.start).copied().ok_or_else(|| {
        invalid(format!("detections[{index}].start could not be converted"))
      })?;
    let end_coordinates =
      coordinates.get(&detection.end).copied().ok_or_else(|| {
        invalid(format!("detections[{index}].end could not be converted"))
      })?;
    let start = start_coordinates.utf8_byte;
    let end = end_coordinates.utf8_byte;
    if start >= end {
      return Err(invalid(format!(
        "detections[{index}] span start must be less than end"
      )));
    }
    detections.push(BindingCallerDetection {
      start,
      end,
      label,
      score: detection.score,
      provider_id: provider_id.to_owned(),
      detection_id: detection.id.clone(),
    });
    coordinate_spans.push((start_coordinates, end_coordinates));
  }
  Ok((detections, coordinate_spans))
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
  convert_external_detection_batch(
    document_bytes,
    batch_json,
    ExternalDetectionOffsetUnit::Utf16CodeUnit,
  )
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
  convert_external_detection_batch(
    document_bytes,
    batch_json,
    ExternalDetectionOffsetUnit::UnicodeCodePoint,
  )
}

fn serialize_request(
  request: &BindingCallerDetectionRequest,
) -> Result<String> {
  serde_json::to_string(request)
    .map_err(|error| invalid(format!("converted request: {error}")))
}

#[derive(Clone, Copy, Default)]
struct BoundaryOffsets {
  utf8_byte: u32,
  utf16_code_unit: u32,
  unicode_code_point: u32,
}

type ConvertedDetections = (
  Vec<BindingCallerDetection>,
  Vec<(BoundaryOffsets, BoundaryOffsets)>,
);

impl BoundaryOffsets {
  const fn get(self, unit: ExternalDetectionOffsetUnit) -> u32 {
    match unit {
      ExternalDetectionOffsetUnit::Utf8Byte => self.utf8_byte,
      ExternalDetectionOffsetUnit::Utf16CodeUnit => self.utf16_code_unit,
      ExternalDetectionOffsetUnit::UnicodeCodePoint => self.unicode_code_point,
    }
  }
}

fn resolve_requested_boundaries(
  full_text: &str,
  requested_offsets: &[u32],
  input_unit: ExternalDetectionOffsetUnit,
) -> Result<BTreeMap<u32, BoundaryOffsets>> {
  if requested_offsets.is_empty() {
    return Ok(BTreeMap::new());
  }
  let mut requested = requested_offsets.to_vec();
  requested.sort_unstable();
  requested.dedup();
  let mut resolved = BTreeMap::new();
  let mut requested_index = 0_usize;
  record_requested_boundary(
    &requested,
    &mut requested_index,
    &mut resolved,
    BoundaryOffsets::default(),
    input_unit,
  )?;

  let mut boundary = BoundaryOffsets::default();
  for (byte_start, character) in full_text.char_indices() {
    if requested_index == requested.len() {
      break;
    }
    boundary = BoundaryOffsets {
      utf8_byte: u32::try_from(
        byte_start
          .checked_add(character.len_utf8())
          .ok_or_else(|| invalid("document byte offset exceeds usize range"))?,
      )
      .map_err(|_| invalid("document byte offset exceeds u32 range"))?,
      utf16_code_unit: boundary
        .utf16_code_unit
        .checked_add(if character.len_utf16() == 1 { 1 } else { 2 })
        .ok_or_else(|| invalid("UTF-16 offset exceeds u32 range"))?,
      unicode_code_point: boundary
        .unicode_code_point
        .checked_add(1)
        .ok_or_else(|| invalid("character offset exceeds u32 range"))?,
    };
    record_requested_boundary(
      &requested,
      &mut requested_index,
      &mut resolved,
      boundary,
      input_unit,
    )?;
  }
  if requested_index != requested.len() {
    return Err(invalid(
      "offset is outside the document or not on a boundary",
    ));
  }
  Ok(resolved)
}

fn record_requested_boundary(
  requested: &[u32],
  requested_index: &mut usize,
  resolved: &mut BTreeMap<u32, BoundaryOffsets>,
  boundary: BoundaryOffsets,
  input_unit: ExternalDetectionOffsetUnit,
) -> Result<()> {
  let input_offset = boundary.get(input_unit);
  while requested.get(*requested_index).copied() == Some(input_offset) {
    resolved.insert(input_offset, boundary);
    *requested_index = requested_index
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
  if value.is_empty() || value.len() > EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES
  {
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

  use std::fmt::Write as _;

  use serde_json::{Value, json};
  use sha2::{Digest, Sha256};

  use super::{
    EXTERNAL_DETECTION_BATCH_MAX_BYTES, EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
    EXTERNAL_DETECTION_MAX_DETECTIONS, EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
    EXTERNAL_DETECTION_MAX_METADATA_BYTES, ExternalDetectionOffsetUnit,
    external_detection_batch_to_caller_request,
    external_detection_batch_to_character_caller_request,
    external_detection_batch_to_character_caller_request_json,
    external_detection_batch_to_utf16_caller_request,
    resolve_requested_boundaries,
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
  fn public_limits_serialize_for_binding_parity() {
    assert_eq!(
      super::external_detection_limits_json().unwrap(),
      r#"{"batchMaxBytes":16777216,"documentMaxBytes":67108864,"maxDetections":100000,"maxLabelMappings":4096,"maxMetadataBytes":256,"providerIdMaxBytes":128}"#
    );
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

      assert_eq!((core.detections[0].start, core.detections[0].end), (4, 9));
      assert_eq!((node.detections[0].start, node.detections[0].end), (2, 7));
      assert_eq!(
        (python.detections[0].start, python.detections[0].end),
        (1, 6)
      );
    }
  }

  #[test]
  fn contract_rejects_stale_unknown_and_duplicate_inputs() {
    let cases = [
      mutate(|batch| batch["version"] = json!(2)),
      mutate(|batch| batch["document"]["sha256"] = json!("0".repeat(64))),
      mutate(|batch| batch["unknown"] = json!(true)),
      mutate(|batch| batch["document"]["unknown"] = json!(true)),
      mutate(|batch| batch["provider"]["unknown"] = json!(true)),
      mutate(|batch| batch["labelMap"][0]["unknown"] = json!(true)),
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
      mutate(|batch| batch["detections"][0]["score"] = json!(1.01)),
      mutate(|batch| batch["detections"][0]["id"] = json!("invalid id")),
      mutate(|batch| {
        let duplicate = batch["labelMap"][0].clone();
        batch["labelMap"].as_array_mut().unwrap().push(duplicate);
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
  fn contract_rejects_document_and_collection_limits() {
    let oversized_document =
      vec![b'a'; EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES.saturating_add(1)];
    assert!(
      external_detection_batch_to_caller_request(&oversized_document, FIXTURE)
        .unwrap_err()
        .to_string()
        .contains("document exceeds byte limit")
    );

    let too_many_detections = mutate(|batch| {
      batch["detections"] = Value::Array(
        (0..=EXTERNAL_DETECTION_MAX_DETECTIONS)
          .map(|_| json!({"id":"x","start":1,"end":2,"label":"PER","score":1}))
          .collect(),
      );
    });
    assert_error_contains(
      DOCUMENT,
      &too_many_detections,
      "detections exceeds entry limit",
    );

    let too_many_mappings = mutate(|batch| {
      batch["labelMap"] = Value::Array(
        (0..=EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS)
          .map(|index| {
            json!({"providerLabel":format!("P{index}"),"entityLabel":"person"})
          })
          .collect(),
      );
      batch["detections"] = json!([]);
    });
    assert_error_contains(
      DOCUMENT,
      &too_many_mappings,
      "labelMap exceeds entry limit",
    );
  }

  #[test]
  fn contract_rejects_metadata_digest_utf8_and_missing_fields() {
    let cases = [
      (
        mutate(|batch| {
          batch["provider"]["name"] =
            json!("x".repeat(EXTERNAL_DETECTION_MAX_METADATA_BYTES + 1));
        }),
        "provider.name",
      ),
      (
        mutate(|batch| {
          batch["provider"]["version"] = json!("   ");
        }),
        "provider.version",
      ),
      (
        mutate(|batch| {
          batch["provider"]["name"] = json!("unsafe\nname");
        }),
        "control-free",
      ),
      (
        mutate(|batch| {
          batch["labelMap"][0]["providerLabel"] = json!("");
        }),
        "labelMap.providerLabel",
      ),
      (
        mutate(|batch| {
          batch["labelMap"][0]["entityLabel"] = json!(" ");
        }),
        "labelMap.entityLabel",
      ),
      (
        mutate(|batch| {
          batch["labelMap"][0]["entityLabel"] = json!("person\u{0007}");
        }),
        "control-free",
      ),
      (
        mutate(|batch| batch["document"]["sha256"] = json!("A".repeat(64))),
        "64 lowercase hexadecimal",
      ),
      (
        mutate(|batch| {
          batch.as_object_mut().unwrap().remove("offsetUnit");
        }),
        "missing field",
      ),
    ];
    for (batch, expected) in cases {
      assert_error_contains(DOCUMENT, &batch, expected);
    }

    let invalid_utf8 = [0xff_u8];
    assert!(
      external_detection_batch_to_caller_request(&invalid_utf8, FIXTURE)
        .unwrap_err()
        .to_string()
        .contains("document is not valid UTF-8")
    );
  }

  #[test]
  fn empty_large_multibyte_documents_need_no_boundary_storage() {
    let document = "é".repeat(1_000_000);
    let batch = batch_for_document(document.as_bytes(), |batch| {
      batch["detections"] = json!([]);
    });
    let batch_json = serde_json::to_string(&batch).unwrap();
    assert!(
      external_detection_batch_to_caller_request(
        document.as_bytes(),
        &batch_json
      )
      .unwrap()
      .detections
      .is_empty()
    );
    assert!(
      external_detection_batch_to_utf16_caller_request(
        document.as_bytes(),
        &batch_json
      )
      .unwrap()
      .detections
      .is_empty()
    );
    assert!(
      external_detection_batch_to_character_caller_request(
        document.as_bytes(),
        &batch_json
      )
      .unwrap()
      .detections
      .is_empty()
    );
    assert!(
      resolve_requested_boundaries(
        &document,
        &[],
        ExternalDetectionOffsetUnit::UnicodeCodePoint
      )
      .unwrap()
      .is_empty()
    );
  }

  #[test]
  fn sparse_resolution_stores_only_requested_multibyte_boundaries() {
    let document = format!("{}Z", "é".repeat(1_000_000));
    let resolved = resolve_requested_boundaries(
      &document,
      &[0, 1_000_000, 1_000_001],
      ExternalDetectionOffsetUnit::UnicodeCodePoint,
    )
    .unwrap();
    assert_eq!(resolved.len(), 3);
    assert_eq!(resolved[&1_000_000].utf8_byte, 2_000_000);
    assert_eq!(resolved[&1_000_001].utf8_byte, 2_000_001);
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

  fn assert_error_contains(document: &[u8], batch: &Value, expected: &str) {
    let error = external_detection_batch_to_caller_request(
      document,
      &serde_json::to_string(&batch).unwrap(),
    )
    .unwrap_err();
    assert!(
      error.to_string().contains(expected),
      "expected {expected:?} in {error}"
    );
  }

  fn batch_for_document(
    document: &[u8],
    update: impl FnOnce(&mut Value),
  ) -> Value {
    let digest = Sha256::digest(document);
    let sha256 =
      digest
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
          write!(output, "{byte:02x}").unwrap();
          output
        });
    mutate(|batch| {
      batch["document"]["sha256"] = json!(sha256);
      update(batch);
    })
  }

  fn mutate(update: impl FnOnce(&mut Value)) -> Value {
    let mut batch = serde_json::from_str(FIXTURE).unwrap();
    update(&mut batch);
    batch
  }
}
