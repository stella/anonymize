use std::collections::BTreeSet;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, Stream, dictionary};
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
  PdfOcrCoverage, PdfPageObservation, PdfRect, inspect_pdf,
  inspect_pdf_with_observations,
};

pub const PDF_RASTER_CONTRACT_VERSION: u8 = 1;
pub const PDF_RASTER_MAX_PAGE_BYTES: usize = 128 * 1024 * 1024;
pub const PDF_RASTER_MAX_TOTAL_BYTES: usize = 512 * 1024 * 1024;
pub const PDF_RASTER_MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;
pub const PDF_RASTER_REQUEST_JSON_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_RASTER_MAX_DETECTIONS: usize = 1_000_000;
pub const PDF_RASTER_MAX_GLYPHS: usize = 5_000_000;
const PDF_RASTER_MAX_PROVIDER_FIELD_BYTES: usize = 256;

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct PdfRasterError {
  code: PdfRasterErrorCode,
  message: String,
}

impl PdfRasterError {
  #[must_use]
  pub const fn code(&self) -> PdfRasterErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum PdfRasterErrorCode {
  InvalidContract,
  LimitExceeded,
  SourceRejected,
  VerificationFailed,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterProvider {
  pub provider_id: String,
  pub renderer_name: String,
  pub renderer_version: String,
  pub ocr_name: String,
  pub ocr_version: String,
  pub ocr_language: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterPage {
  pub observation: PdfPageObservation,
  pub width_pixels: u32,
  pub height_pixels: u32,
  pub pixel_sha256: String,
  pub detections: Vec<PdfRasterDetection>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterDetection {
  pub start: u32,
  pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterRewrite {
  pub contract_version: u8,
  pub source_sha256: String,
  pub provider: PdfRasterProvider,
  pub fill_rgb: [u8; 3],
  pub pages: Vec<PdfRasterPage>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRasterRewriteCertificate {
  pub contract_version: u8,
  pub page_count: u32,
  pub source_sha256: String,
  pub output_sha256: String,
  pub provider: PdfRasterProvider,
  pub detection_count: u32,
  pub mapped_region_count: u32,
  pub structure_pixel_rewrite_verified: bool,
  pub provider_asserted_coverage: String,
  pub pii_clean_guaranteed: bool,
  pub limitation: String,
}

fn error(
  code: PdfRasterErrorCode,
  message: impl Into<String>,
) -> PdfRasterError {
  PdfRasterError {
    code,
    message: message.into(),
  }
}

fn digest_hex(bytes: &[u8]) -> String {
  let digest = Sha256::digest(bytes);
  let mut result = String::with_capacity(64);
  for byte in digest {
    use std::fmt::Write;
    let _ = write!(&mut result, "{byte:02x}");
  }
  result
}

fn validate_provider(
  provider: &PdfRasterProvider,
) -> Result<(), PdfRasterError> {
  for (label, value) in [
    ("provider id", &provider.provider_id),
    ("renderer name", &provider.renderer_name),
    ("renderer version", &provider.renderer_version),
    ("OCR name", &provider.ocr_name),
    ("OCR version", &provider.ocr_version),
    ("OCR language", &provider.ocr_language),
  ] {
    if value.is_empty()
      || value.trim() != value
      || value.len() > PDF_RASTER_MAX_PROVIDER_FIELD_BYTES
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        format!(
          "PDF raster {label} must be trimmed and contain 1..={PDF_RASTER_MAX_PROVIDER_FIELD_BYTES} UTF-8 bytes"
        ),
      ));
    }
    if value.chars().any(char::is_control) {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        format!("PDF raster {label} must not contain control characters"),
      ));
    }
  }
  if !provider.ocr_language.bytes().all(|byte| {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
  }) {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster OCR language must name one explicit language pack",
    ));
  }
  Ok(())
}

fn checked_pixel_length(page: &PdfRasterPage) -> Result<usize, PdfRasterError> {
  let width = usize::try_from(page.width_pixels).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster width overflowed",
    )
  })?;
  let height = usize::try_from(page.height_pixels).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster height overflowed",
    )
  })?;
  width
    .checked_mul(height)
    .and_then(|value| value.checked_mul(3))
    .ok_or_else(|| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster pixel length overflowed",
      )
    })
}

fn point_object(value: f64) -> Result<Object, PdfRasterError> {
  value.to_f32().map(Object::Real).ok_or_else(|| {
    error(
      PdfRasterErrorCode::InvalidContract,
      "PDF page point dimension cannot be represented",
    )
  })
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct PixelRect {
  left: usize,
  top: usize,
  right: usize,
  bottom: usize,
}

fn pixel_rect(
  page: &PdfRasterPage,
  rect: &PdfRect,
) -> Result<PixelRect, PdfRasterError> {
  let observation = &page.observation;
  let valid = [rect.left, rect.bottom, rect.right, rect.top]
    .into_iter()
    .all(f64::is_finite)
    && rect.left >= 0.0
    && rect.bottom >= 0.0
    && rect.right > rect.left
    && rect.top > rect.bottom
    && rect.right <= observation.width_points
    && rect.top <= observation.height_points;
  if !valid {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster redaction rectangle is outside its page",
    ));
  }
  let width = f64::from(page.width_pixels);
  let height = f64::from(page.height_pixels);
  let pixel_width = usize::try_from(page.width_pixels).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster width overflowed",
    )
  })?;
  let pixel_height = usize::try_from(page.height_pixels).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster height overflowed",
    )
  })?;
  let left = (rect.left / observation.width_points * width)
    .floor()
    .to_usize()
    .map(|value| value.saturating_sub(1));
  let right = (rect.right / observation.width_points * width)
    .ceil()
    .to_usize()
    .and_then(|value| value.checked_add(1))
    .map(|value| value.min(pixel_width));
  let top = ((observation.height_points - rect.top)
    / observation.height_points
    * height)
    .floor()
    .to_usize()
    .map(|value| value.saturating_sub(1));
  let bottom = ((observation.height_points - rect.bottom)
    / observation.height_points
    * height)
    .ceil()
    .to_usize()
    .and_then(|value| value.checked_add(1))
    .map(|value| value.min(pixel_height));
  match (left, top, right, bottom) {
    (Some(left), Some(top), Some(right), Some(bottom))
      if left < right && top < bottom =>
    {
      Ok(PixelRect {
        left,
        top,
        right,
        bottom,
      })
    }
    _ => Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster redaction rectangle cannot be mapped to pixels",
    )),
  }
}

fn fill_pixels(
  pixels: &mut [u8],
  width: usize,
  rects: &[PixelRect],
  fill: [u8; 3],
) -> Result<(), PdfRasterError> {
  for rect in rects {
    for y in rect.top..rect.bottom {
      for x in rect.left..rect.right {
        let offset = y
          .checked_mul(width)
          .and_then(|value| value.checked_add(x))
          .and_then(|value| value.checked_mul(3))
          .ok_or_else(|| {
            error(
              PdfRasterErrorCode::LimitExceeded,
              "PDF raster pixel offset overflowed",
            )
          })?;
        let end = offset.checked_add(3).ok_or_else(|| {
          error(
            PdfRasterErrorCode::LimitExceeded,
            "PDF raster pixel offset overflowed",
          )
        })?;
        let pixel = pixels.get_mut(offset..end).ok_or_else(|| {
          error(
            PdfRasterErrorCode::InvalidContract,
            "PDF raster pixel buffer is truncated",
          )
        })?;
        pixel.copy_from_slice(&fill);
      }
    }
  }
  Ok(())
}

// Span-to-glyph coverage is intentionally kept together for fail-closed auditability.
#[allow(clippy::too_many_lines)]
fn detection_pixel_rects(
  page: &PdfRasterPage,
) -> Result<Vec<PixelRect>, PdfRasterError> {
  if page.detections.len() > PDF_RASTER_MAX_DETECTIONS
    || page.observation.glyphs.len() > PDF_RASTER_MAX_GLYPHS
  {
    return Err(error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster detections or glyphs exceed their count limit",
    ));
  }
  let mut required_units = Vec::new();
  let mut boundaries = BTreeSet::from([0u32]);
  let mut utf16_offset = 0u32;
  for character in page.observation.text.chars() {
    utf16_offset = utf16_offset
      .checked_add(u32::try_from(character.len_utf16()).map_err(|_| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster observed text offset overflowed",
        )
      })?)
      .ok_or_else(|| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster observed text offset overflowed",
        )
      })?;
    boundaries.insert(utf16_offset);
    required_units.extend(std::iter::repeat_n(
      !character.is_whitespace(),
      character.len_utf16(),
    ));
  }
  let mut mapped = BTreeSet::new();
  let mut glyph_cursor = 0usize;
  let mut previous_detection_end = 0u32;
  for detection in &page.detections {
    if !boundaries.contains(&detection.start)
      || !boundaries.contains(&detection.end)
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection splits a UTF-16 character",
      ));
    }
    let start = usize::try_from(detection.start).map_err(|_| {
      error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection start overflowed",
      )
    })?;
    let end = usize::try_from(detection.end).map_err(|_| {
      error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection end overflowed",
      )
    })?;
    if start >= end {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection span is empty",
      ));
    }
    if detection.start < previous_detection_end {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detections must be ordered and non-overlapping",
      ));
    }
    previous_detection_end = detection.end;
    let selected_units = required_units.get(start..end).ok_or_else(|| {
      error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection is outside observed text",
      )
    })?;
    let coverage_len = end.checked_sub(start).ok_or_else(|| {
      error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection span is invalid",
      )
    })?;
    let mut covered = vec![false; coverage_len];
    let mut regions = 0usize;
    while page
      .observation
      .glyphs
      .get(glyph_cursor)
      .is_some_and(|glyph| glyph.end <= detection.start)
    {
      glyph_cursor = glyph_cursor.saturating_add(1);
    }
    for glyph in page.observation.glyphs.iter().skip(glyph_cursor) {
      if glyph.start >= detection.end {
        break;
      }
      let glyph_start = usize::try_from(glyph.start)
        .map_err(|_| {
          error(
            PdfRasterErrorCode::InvalidContract,
            "PDF raster glyph start overflowed",
          )
        })?
        .max(start)
        .saturating_sub(start);
      let glyph_end = usize::try_from(glyph.end)
        .map_err(|_| {
          error(
            PdfRasterErrorCode::InvalidContract,
            "PDF raster glyph end overflowed",
          )
        })?
        .min(end)
        .saturating_sub(start);
      for unit in covered.iter_mut().take(glyph_end).skip(glyph_start) {
        *unit = true;
      }
      mapped.insert(pixel_rect(page, &glyph.bounds)?);
      regions = regions.saturating_add(1);
    }
    let fully_mapped = selected_units
      .iter()
      .zip(&covered)
      .all(|(required, covered)| !required || *covered);
    if regions == 0 || !fully_mapped {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster detection is not fully mapped to observed glyph geometry",
      ));
    }
  }
  Ok(mapped.into_iter().collect())
}

fn validate_request_header(
  source: &[u8],
  request: &PdfRasterRewrite,
) -> Result<(), PdfRasterError> {
  if request.contract_version != PDF_RASTER_CONTRACT_VERSION {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "unsupported PDF raster contract version",
    ));
  }
  if digest_hex(source) != request.source_sha256 {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster source digest does not match",
    ));
  }
  validate_provider(&request.provider)
}

fn validate_source_and_pages(
  source: &[u8],
  request: &PdfRasterRewrite,
) -> Result<(), PdfRasterError> {
  validate_request_header(source, request)?;
  let inspection = inspect_pdf(source).map_err(|source_error| {
    error(PdfRasterErrorCode::SourceRejected, source_error.to_string())
  })?;
  if inspection.encrypted {
    return Err(error(
      PdfRasterErrorCode::SourceRejected,
      "encrypted PDFs are not supported by raster anonymization",
    ));
  }
  let expected_pages =
    usize::try_from(inspection.page_count).map_err(|_| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF page count overflowed",
      )
    })?;
  if request.pages.len() != expected_pages {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster contract must contain every source page exactly once",
    ));
  }
  let mut observations = Vec::with_capacity(request.pages.len());
  for (source_index, page) in request.pages.iter().enumerate() {
    let source_index = u32::try_from(source_index).map_err(|_| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster page index overflowed",
      )
    })?;
    if page.observation.page_index != source_index
      || !page.observation.rendered
      || page.observation.ocr != PdfOcrCoverage::Complete
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster observations must be in source order with complete rendering and OCR",
      ));
    }
    if page.width_pixels == 0
      || page.height_pixels == 0
      || !page.observation.width_points.is_finite()
      || !page.observation.height_points.is_finite()
      || page.observation.width_points <= 0.0
      || page.observation.height_points <= 0.0
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster page dimensions are invalid",
      ));
    }
    let horizontal_scale =
      f64::from(page.width_pixels) / page.observation.width_points;
    let vertical_scale =
      f64::from(page.height_pixels) / page.observation.height_points;
    let scale_difference = (horizontal_scale - vertical_scale).abs();
    let scale_tolerance = horizontal_scale.max(vertical_scale) * 0.001;
    if scale_difference > scale_tolerance {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster page pixels must use the same horizontal and vertical scale",
      ));
    }
    if page.detections.len() > PDF_RASTER_MAX_DETECTIONS
      || page.observation.glyphs.len() > PDF_RASTER_MAX_GLYPHS
    {
      return Err(error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster page contains too many detections or glyphs",
      ));
    }
    observations.push(page.observation.clone());
  }
  inspect_pdf_with_observations(source, observations).map_err(
    |source_error| {
      error(
        PdfRasterErrorCode::InvalidContract,
        source_error.to_string(),
      )
    },
  )?;
  Ok(())
}

fn content_bytes(width: f64, height: f64) -> Result<Vec<u8>, PdfRasterError> {
  Content {
    operations: vec![
      Operation::new("q", vec![]),
      Operation::new(
        "cm",
        vec![
          point_object(width)?,
          Object::Integer(0),
          Object::Integer(0),
          point_object(height)?,
          Object::Integer(0),
          Object::Integer(0),
        ],
      ),
      Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
      Operation::new("Q", vec![]),
    ],
  }
  .encode()
  .map_err(|encode_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      format!("PDF raster content encoding failed: {encode_error}"),
    )
  })
}

fn verification_failure(message: impl Into<String>) -> PdfRasterError {
  error(PdfRasterErrorCode::VerificationFailed, message)
}

fn exact_pdf_number(object: &Object) -> Option<f64> {
  match object {
    Object::Integer(value) => value.to_f64(),
    Object::Real(value) => Some(f64::from(*value)),
    _ => None,
  }
}

// The exact page/resource/content graph is one security invariant.
#[allow(clippy::too_many_lines)]
fn verify_page_graph(
  parsed: &Document,
  page_id: lopdf::ObjectId,
  expected: &PdfRasterPage,
  expected_image_digest: &str,
) -> Result<(), PdfRasterError> {
  let page = parsed
    .get_object(page_id)
    .and_then(Object::as_dict)
    .map_err(|_| verification_failure("PDF raster output page is invalid"))?;
  let media_box =
    page
      .get(b"MediaBox")
      .and_then(Object::as_array)
      .map_err(|_| {
        verification_failure("PDF raster output MediaBox is invalid")
      })?;
  let expected_width =
    f64::from(expected.observation.width_points.to_f32().ok_or_else(|| {
      verification_failure("PDF raster expected page width is invalid")
    })?);
  let expected_height =
    f64::from(expected.observation.height_points.to_f32().ok_or_else(
      || verification_failure("PDF raster expected page height is invalid"),
    )?);
  let exact_geometry = media_box.len() == 4
    && media_box.first().and_then(exact_pdf_number) == Some(0.0)
    && media_box.get(1).and_then(exact_pdf_number) == Some(0.0)
    && media_box.get(2).and_then(exact_pdf_number) == Some(expected_width)
    && media_box.get(3).and_then(exact_pdf_number) == Some(expected_height);
  if !exact_geometry {
    return Err(verification_failure(
      "PDF raster output page geometry differs from its source observation",
    ));
  }
  let resources =
    page
      .get(b"Resources")
      .and_then(Object::as_dict)
      .map_err(|_| {
        verification_failure("PDF raster output resources are invalid")
      })?;
  if resources.len() != 1 {
    return Err(verification_failure(
      "PDF raster output resources contain non-image entries",
    ));
  }
  let xobjects = resources
    .get(b"XObject")
    .and_then(Object::as_dict)
    .map_err(|_| {
      verification_failure("PDF raster output XObjects are invalid")
    })?;
  if xobjects.len() != 1 {
    return Err(verification_failure(
      "PDF raster output page must reference exactly one image",
    ));
  }
  let image_id = xobjects
    .get(b"Im0")
    .and_then(Object::as_reference)
    .map_err(|_| {
      verification_failure("PDF raster output image reference is invalid")
    })?;
  let image = parsed
    .get_object(image_id)
    .and_then(Object::as_stream)
    .map_err(|_| verification_failure("PDF raster output image is invalid"))?;
  if image
    .dict
    .get(b"Type")
    .ok()
    .and_then(|value| value.as_name().ok())
    != Some(b"XObject".as_slice())
    || image
      .dict
      .get(b"Subtype")
      .ok()
      .and_then(|value| value.as_name().ok())
      != Some(b"Image".as_slice())
    || image
      .dict
      .get(b"Width")
      .ok()
      .and_then(|value| value.as_i64().ok())
      != Some(i64::from(expected.width_pixels))
    || image
      .dict
      .get(b"Height")
      .ok()
      .and_then(|value| value.as_i64().ok())
      != Some(i64::from(expected.height_pixels))
    || image
      .dict
      .get(b"ColorSpace")
      .ok()
      .and_then(|value| value.as_name().ok())
      != Some(b"DeviceRGB".as_slice())
    || image
      .dict
      .get(b"BitsPerComponent")
      .ok()
      .and_then(|value| value.as_i64().ok())
      != Some(8)
    || image
      .dict
      .get(b"Filter")
      .ok()
      .and_then(|value| value.as_name().ok())
      != Some(b"FlateDecode".as_slice())
  {
    return Err(verification_failure(
      "PDF raster output image parameters differ from the supplied RGB8 page",
    ));
  }
  let pixels = image
    .get_plain_content_with_limit(PDF_RASTER_MAX_PAGE_BYTES)
    .map_err(|failure| {
      verification_failure(format!(
        "PDF raster output image could not be decoded: {failure}"
      ))
    })?;
  if digest_hex(&pixels) != expected_image_digest {
    return Err(verification_failure(
      "PDF raster output image pixels differ from the destructively filled page",
    ));
  }
  let content_id = page
    .get(b"Contents")
    .and_then(Object::as_reference)
    .map_err(|_| {
      verification_failure("PDF raster output content reference is invalid")
    })?;
  let content = parsed
    .get_object(content_id)
    .and_then(Object::as_stream)
    .map_err(|_| {
      verification_failure("PDF raster output content stream is invalid")
    })?;
  let decoded =
    Content::decode_strict(&content.content).map_err(|failure| {
      verification_failure(format!(
        "PDF raster output content could not be decoded: {failure}"
      ))
    })?;
  let expected_content = Content::decode_strict(&content_bytes(
    expected.observation.width_points,
    expected.observation.height_points,
  )?)
  .map_err(|failure| {
    verification_failure(format!(
      "PDF raster expected content could not be decoded: {failure}"
    ))
  })?;
  let exact_operations = decoded.operations.len()
    == expected_content.operations.len()
    && decoded
      .operations
      .iter()
      .zip(&expected_content.operations)
      .all(|(actual, expected_operation)| {
        actual.operator == expected_operation.operator
          && actual.operands == expected_operation.operands
      });
  if !exact_operations {
    return Err(verification_failure(
      "PDF raster output content operators differ from the image-only program",
    ));
  }
  Ok(())
}

// Keep the complete output-object allowlist in one auditable pass.
#[allow(clippy::too_many_lines)]
fn verify_output(
  output: &[u8],
  expected_pages: &[PdfRasterPage],
  expected_image_digests: &[String],
) -> Result<(), PdfRasterError> {
  const CATALOG_KEYS: &[&[u8]] = &[b"Type", b"Pages"];
  const PAGE_TREE_KEYS: &[&[u8]] = &[b"Type", b"Kids", b"Count"];
  const PAGE_KEYS: &[&[u8]] =
    &[b"Type", b"Parent", b"MediaBox", b"Resources", b"Contents"];
  if output.len() > PDF_RASTER_MAX_OUTPUT_BYTES {
    return Err(error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster output exceeds its byte limit",
    ));
  }
  let parsed = Document::load_mem(output).map_err(|verify_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      format!("PDF raster output could not be reparsed: {verify_error}"),
    )
  })?;
  let expected_object_count = expected_pages
    .len()
    .checked_mul(3)
    // Catalog, page tree, and the writer's cross-reference stream.
    .and_then(|count| count.checked_add(3))
    .ok_or_else(|| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster output object count overflowed",
      )
    })?;
  if parsed.objects.len() != expected_object_count {
    return Err(error(
      PdfRasterErrorCode::VerificationFailed,
      format!(
        "PDF raster output contains {} objects; expected {expected_object_count} image-only objects",
        parsed.objects.len()
      ),
    ));
  }
  let page_ids = parsed.get_pages();
  if page_ids.len() != expected_pages.len() {
    return Err(verification_failure(
      "PDF raster output page tree differs from the rewrite contract",
    ));
  }
  for (index, (page_id, expected_digest)) in
    page_ids.values().zip(expected_image_digests).enumerate()
  {
    let expected_page = expected_pages.get(index).ok_or_else(|| {
      verification_failure("PDF raster output page index is invalid")
    })?;
    verify_page_graph(&parsed, *page_id, expected_page, expected_digest)?;
  }
  let mut catalog_count = 0usize;
  let mut page_tree_count = 0usize;
  let mut page_count = 0usize;
  let mut content_stream_count = 0usize;
  let mut xref_stream_count = 0usize;
  for object in parsed.objects.values() {
    if matches!(object, Object::String(_, _)) {
      return Err(error(
        PdfRasterErrorCode::VerificationFailed,
        "PDF raster output contains a string object",
      ));
    }
    match object {
      Object::Dictionary(dictionary) => {
        let object_type = dictionary
          .get(b"Type")
          .ok()
          .and_then(|value| value.as_name().ok());
        let allowed = match object_type {
          Some(b"Catalog") => {
            catalog_count = catalog_count.saturating_add(1);
            CATALOG_KEYS
          }
          Some(b"Pages") => {
            page_tree_count = page_tree_count.saturating_add(1);
            PAGE_TREE_KEYS
          }
          Some(b"Page") => {
            page_count = page_count.saturating_add(1);
            PAGE_KEYS
          }
          _ => &[],
        };
        if allowed.is_empty()
          || dictionary
            .iter()
            .any(|(key, _)| !allowed.contains(&key.as_slice()))
        {
          return Err(error(
            PdfRasterErrorCode::VerificationFailed,
            "PDF raster output contains a dictionary outside the image-only allowlist",
          ));
        }
      }
      Object::Stream(stream) => {
        let object_type = stream
          .dict
          .get(b"Type")
          .ok()
          .and_then(|value| value.as_name().ok());
        let subtype = stream
          .dict
          .get(b"Subtype")
          .ok()
          .and_then(|value| value.as_name().ok());
        if subtype == Some(b"Image".as_slice()) {
          let allowed = [
            b"Type".as_slice(),
            b"Subtype".as_slice(),
            b"Width".as_slice(),
            b"Height".as_slice(),
            b"ColorSpace".as_slice(),
            b"BitsPerComponent".as_slice(),
            b"Filter".as_slice(),
            b"Length".as_slice(),
          ];
          if stream
            .dict
            .iter()
            .any(|(key, _)| !allowed.contains(&key.as_slice()))
          {
            return Err(error(
              PdfRasterErrorCode::VerificationFailed,
              "PDF raster output image contains a non-allowlisted field",
            ));
          }
        } else if object_type == Some(b"XRef".as_slice()) {
          const XREF_KEYS: &[&[u8]] =
            &[b"Type", b"Root", b"Size", b"W", b"Index", b"Length"];
          if stream
            .dict
            .iter()
            .any(|(key, _)| !XREF_KEYS.contains(&key.as_slice()))
          {
            return Err(error(
              PdfRasterErrorCode::VerificationFailed,
              "PDF raster output cross-reference contains a non-allowlisted field",
            ));
          }
          xref_stream_count = xref_stream_count.saturating_add(1);
        } else if stream
          .dict
          .iter()
          .all(|(key, _)| key.as_slice() == b"Length")
        {
          content_stream_count = content_stream_count.saturating_add(1);
        } else {
          return Err(error(
            PdfRasterErrorCode::VerificationFailed,
            "PDF raster output contains a stream outside the image-only allowlist",
          ));
        }
      }
      _ => {
        return Err(error(
          PdfRasterErrorCode::VerificationFailed,
          "PDF raster output contains an object outside the image-only allowlist",
        ));
      }
    }
  }
  if catalog_count != 1
    || page_tree_count != 1
    || page_count != expected_pages.len()
    || content_stream_count != expected_pages.len()
    || xref_stream_count != 1
  {
    return Err(error(
      PdfRasterErrorCode::VerificationFailed,
      "PDF raster output image pixels differ from the destructively filled pages",
    ));
  }
  Ok(())
}

struct AddedRasterPage {
  output_page_id: lopdf::ObjectId,
  sanitized_digest: String,
  mapped_region_count: usize,
}

fn add_raster_page(
  document: &mut Document,
  page_tree_id: lopdf::ObjectId,
  page: &PdfRasterPage,
  supplied_pixels: &[u8],
  fill_rgb: [u8; 3],
) -> Result<AddedRasterPage, PdfRasterError> {
  let expected = checked_pixel_length(page)?;
  if expected > PDF_RASTER_MAX_PAGE_BYTES || supplied_pixels.len() != expected {
    return Err(error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster page pixels exceed limits or have an invalid RGB8 length",
    ));
  }
  if digest_hex(supplied_pixels) != page.pixel_sha256 {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster page digest does not match",
    ));
  }
  let rects = detection_pixel_rects(page)?;
  let mut pixels = supplied_pixels.to_vec();
  let width = usize::try_from(page.width_pixels).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster width overflowed",
    )
  })?;
  fill_pixels(&mut pixels, width, &rects, fill_rgb)?;
  let sanitized_digest = digest_hex(&pixels);
  let mut image = Stream::new(
    dictionary! {
      "Type" => "XObject", "Subtype" => "Image",
      "Width" => i64::from(page.width_pixels), "Height" => i64::from(page.height_pixels),
      "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    },
    pixels,
  );
  image.compress().map_err(|compress_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      format!("PDF raster image compression failed: {compress_error}"),
    )
  })?;
  let image_id = document.add_object(image);
  let content_id = document.add_object(Stream::new(
    Dictionary::new(),
    content_bytes(
      page.observation.width_points,
      page.observation.height_points,
    )?,
  ));
  let output_page_id = document.add_object(dictionary! {
    "Type" => "Page", "Parent" => page_tree_id,
    "MediaBox" => vec![Object::Integer(0), Object::Integer(0), point_object(page.observation.width_points)?, point_object(page.observation.height_points)?],
    "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
    "Contents" => content_id,
  });
  Ok(AddedRasterPage {
    output_page_id,
    sanitized_digest,
    mapped_region_count: rects.len(),
  })
}

/// Destructively fills regions derived from selected detection spans and observed glyphs.
/// No object or byte range from the source PDF is copied into the output.
#[allow(clippy::too_many_lines)]
pub fn rewrite_pdf_raster_from_detections<T: AsRef<[u8]>>(
  source: &[u8],
  request: &PdfRasterRewrite,
  page_pixels: &[T],
) -> Result<(Vec<u8>, PdfRasterRewriteCertificate), PdfRasterError> {
  validate_source_and_pages(source, request)?;
  if page_pixels.len() != request.pages.len() {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster pixel buffers must match the page contract",
    ));
  }
  let mut total_bytes = 0usize;
  let mut detection_count = 0usize;
  for (page, supplied_pixels) in request.pages.iter().zip(page_pixels) {
    let expected = checked_pixel_length(page)?;
    if expected > PDF_RASTER_MAX_PAGE_BYTES
      || supplied_pixels.as_ref().len() != expected
    {
      return Err(error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster page pixels exceed limits or have an invalid RGB8 length",
      ));
    }
    total_bytes = total_bytes.checked_add(expected).ok_or_else(|| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster total pixel length overflowed",
      )
    })?;
    detection_count = detection_count
      .checked_add(page.detections.len())
      .ok_or_else(|| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster detection count overflowed",
        )
      })?;
  }
  if total_bytes > PDF_RASTER_MAX_TOTAL_BYTES
    || detection_count > PDF_RASTER_MAX_DETECTIONS
  {
    return Err(error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster pixels or detections exceed their aggregate limit",
    ));
  }
  let mut mapped_region_count = 0usize;
  let mut document = Document::with_version("1.7");
  let mut expected_image_digests = Vec::with_capacity(request.pages.len());
  let page_tree_id = document.new_object_id();
  let catalog_id = document
    .add_object(dictionary! { "Type" => "Catalog", "Pages" => page_tree_id });
  let mut kids = Vec::with_capacity(request.pages.len());
  for (page, supplied_pixels) in request.pages.iter().zip(page_pixels) {
    let added = add_raster_page(
      &mut document,
      page_tree_id,
      page,
      supplied_pixels.as_ref(),
      request.fill_rgb,
    )?;
    mapped_region_count = mapped_region_count
      .checked_add(added.mapped_region_count)
      .ok_or_else(|| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster mapped region count overflowed",
        )
      })?;
    expected_image_digests.push(added.sanitized_digest);
    kids.push(Object::Reference(added.output_page_id));
  }
  let count = i64::try_from(kids.len()).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster page count overflowed",
    )
  })?;
  document.objects.insert(
    page_tree_id,
    Object::Dictionary(
      dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count },
    ),
  );
  document.trailer.set("Root", catalog_id);
  let mut output = Vec::new();
  document.save_to(&mut output).map_err(|write_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      format!("PDF raster output could not be written: {write_error}"),
    )
  })?;
  verify_output(&output, &request.pages, &expected_image_digests)?;
  let page_count = u32::try_from(request.pages.len()).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster page count overflowed",
    )
  })?;
  let detection_count = u32::try_from(detection_count).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster detection count overflowed",
    )
  })?;
  let mapped_region_count =
    u32::try_from(mapped_region_count).map_err(|_| {
      error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster mapped region count overflowed",
      )
    })?;
  let certificate = PdfRasterRewriteCertificate {
    contract_version: PDF_RASTER_CONTRACT_VERSION,
    page_count,
    source_sha256: request.source_sha256.clone(),
    output_sha256: digest_hex(&output),
    provider: request.provider.clone(),
    detection_count,
    mapped_region_count,
    structure_pixel_rewrite_verified: true,
    provider_asserted_coverage:
      "complete-rendering-and-ocr-observation".to_owned(),
    pii_clean_guaranteed: false,
    limitation: "Structure and pixel rewrite verification does not prove OCR or detector recall and does not certify that the output is PII-free."
      .to_owned(),
  };
  Ok((output, certificate))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{PdfGlyphObservation, PdfTextLayerCoverage};

  const SOURCE: &[u8] = include_bytes!("../tests/fixtures/minimal-text.pdf");

  fn request(pixels: &[u8]) -> PdfRasterRewrite {
    PdfRasterRewrite {
      contract_version: PDF_RASTER_CONTRACT_VERSION,
      source_sha256: digest_hex(SOURCE),
      provider: PdfRasterProvider {
        provider_id: "synthetic-test-provider".to_owned(),
        renderer_name: "synthetic-renderer".to_owned(),
        renderer_version: "1.0.0".to_owned(),
        ocr_name: "synthetic-ocr".to_owned(),
        ocr_version: "1.0.0".to_owned(),
        ocr_language: "eng".to_owned(),
      },
      fill_rgb: [0, 0, 0],
      pages: vec![PdfRasterPage {
        observation: PdfPageObservation {
          page_index: 0,
          width_points: 612.0,
          height_points: 792.0,
          text: "Alice".to_owned(),
          glyphs: vec![PdfGlyphObservation {
            start: 0,
            end: 5,
            bounds: PdfRect {
              left: 72.0,
              bottom: 396.0,
              right: 216.0,
              top: 540.0,
            },
            source: crate::PdfGlyphSource::Ocr,
          }],
          rendered: true,
          text_layer: PdfTextLayerCoverage::Absent,
          ocr: PdfOcrCoverage::Complete,
          image_count: 0,
        },
        width_pixels: 17,
        height_pixels: 22,
        pixel_sha256: digest_hex(pixels),
        detections: vec![PdfRasterDetection { start: 0, end: 5 }],
      }],
    }
  }

  #[test]
  fn creates_verified_fresh_image_only_pdf() {
    let pixels = vec![255; 17 * 22 * 3];
    let result =
      rewrite_pdf_raster_from_detections(SOURCE, &request(&pixels), &[pixels]);
    assert!(result.is_ok(), "{result:?}");
    let Ok((output, certificate)) = result else {
      return;
    };
    assert!(certificate.structure_pixel_rewrite_verified);
    assert!(!certificate.pii_clean_guaranteed);
    assert_eq!(certificate.page_count, 1);
    assert_eq!(certificate.detection_count, 1);
    assert_eq!(certificate.mapped_region_count, 1);
    assert!(
      !output
        .windows(b"Public fixture".len())
        .any(|window| { window == b"Public fixture" })
    );
    let inspection_result = inspect_pdf(&output);
    assert!(inspection_result.is_ok());
    let Ok(inspection) = inspection_result else {
      return;
    };
    assert_eq!(inspection.risks.image_object_count, 1);
    assert_eq!(inspection.risks.metadata_stream_count, 0);
    assert_eq!(inspection.risks.embedded_file_count, 0);
    assert_eq!(inspection.risks.annotation_count, 0);
  }

  #[test]
  fn maps_ordered_non_overlapping_detections_with_one_glyph_sweep() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut contract = request(&pixels);
    let Some(page) = contract.pages.first_mut() else {
      return;
    };
    page.observation.text = "Alice Bob".to_owned();
    page.observation.glyphs.push(PdfGlyphObservation {
      start: 6,
      end: 9,
      bounds: PdfRect {
        left: 216.0,
        bottom: 396.0,
        right: 288.0,
        top: 540.0,
      },
      source: crate::PdfGlyphSource::Ocr,
    });
    page
      .detections
      .push(PdfRasterDetection { start: 6, end: 9 });

    let rects = detection_pixel_rects(page);

    assert!(rects.is_ok());
    assert_eq!(rects.map(|value| value.len()), Ok(2));
  }

  #[test]
  fn rejects_overlapping_or_out_of_order_detections() {
    let pixels = vec![255; 17 * 22 * 3];
    for detections in [
      vec![
        PdfRasterDetection { start: 0, end: 5 },
        PdfRasterDetection { start: 4, end: 5 },
      ],
      vec![
        PdfRasterDetection { start: 4, end: 5 },
        PdfRasterDetection { start: 0, end: 1 },
      ],
    ] {
      let mut contract = request(&pixels);
      let Some(page) = contract.pages.first_mut() else {
        return;
      };
      page.detections = detections;

      assert_eq!(
        detection_pixel_rects(page)
          .err()
          .map(|failure| failure.code()),
        Some(PdfRasterErrorCode::InvalidContract),
      );
    }
  }

  #[test]
  fn raster_limit_is_not_reduced_by_the_general_inspector_stream_limit() {
    let pixels = vec![255; 3_200 * 4_141 * 3];
    assert!(pixels.len() > crate::PDF_STREAM_DECOMPRESSED_MAX_BYTES);
    let mut contract = request(&pixels);
    let Some(page) = contract.pages.first_mut() else {
      return;
    };
    page.width_pixels = 3_200;
    page.height_pixels = 4_141;

    let result = rewrite_pdf_raster_from_detections(
      SOURCE,
      &contract,
      std::slice::from_ref(&pixels),
    );

    assert!(result.is_ok(), "{result:?}");
  }

  #[test]
  fn rejects_incomplete_or_mismatched_provider_contracts() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut incomplete = request(&pixels);
    for page in &mut incomplete.pages {
      page.observation.ocr = PdfOcrCoverage::Partial;
    }
    assert_eq!(
      rewrite_pdf_raster_from_detections(
        SOURCE,
        &incomplete,
        std::slice::from_ref(&pixels),
      )
      .err()
      .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract)
    );

    let mut wrong_digest = request(&pixels);
    for page in &mut wrong_digest.pages {
      page.pixel_sha256 = "00".repeat(32);
    }
    assert_eq!(
      rewrite_pdf_raster_from_detections(
        SOURCE,
        &wrong_digest,
        std::slice::from_ref(&pixels),
      )
      .err()
      .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract)
    );

    let mut invalid_provider = request(&pixels);
    invalid_provider.provider.provider_id.clear();
    assert_eq!(
      rewrite_pdf_raster_from_detections(SOURCE, &invalid_provider, &[pixels])
        .err()
        .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract)
    );
  }

  #[test]
  fn rejects_encrypted_sources() {
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};

    let document_result = Document::load_mem(SOURCE);
    assert!(document_result.is_ok());
    let Ok(mut document) = document_result else {
      return;
    };
    let version = EncryptionVersion::V1 {
      document: &document,
      owner_password: "owner",
      user_password: "user",
      permissions: Permissions::empty(),
    };
    let state_result = EncryptionState::try_from(version);
    assert!(state_result.is_ok());
    let Ok(state) = state_result else {
      return;
    };
    assert!(document.encrypt(&state).is_ok());
    let mut encrypted = Vec::new();
    assert!(document.save_to(&mut encrypted).is_ok());
    let pixels = vec![255; 17 * 22 * 3];
    let mut encrypted_request = request(&pixels);
    encrypted_request.source_sha256 = digest_hex(&encrypted);
    assert_eq!(
      rewrite_pdf_raster_from_detections(
        &encrypted,
        &encrypted_request,
        &[pixels]
      )
      .err()
      .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::SourceRejected)
    );
  }

  #[test]
  fn rejects_missing_pages_and_out_of_bounds_rectangles() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut missing = request(&pixels);
    missing.pages.clear();
    let no_pixels: [Vec<u8>; 0] = [];
    assert!(
      rewrite_pdf_raster_from_detections(SOURCE, &missing, &no_pixels).is_err()
    );

    let mut invalid_geometry = request(&pixels);
    for page in &mut invalid_geometry.pages {
      for glyph in &mut page.observation.glyphs {
        glyph.bounds.right = 700.0;
      }
    }
    assert!(
      rewrite_pdf_raster_from_detections(
        SOURCE,
        &invalid_geometry,
        std::slice::from_ref(&pixels),
      )
      .is_err()
    );

    let mut wrong_index = request(&pixels);
    let Some(page) = wrong_index.pages.first_mut() else {
      return;
    };
    page.observation.page_index = 1;
    assert_eq!(
      rewrite_pdf_raster_from_detections(SOURCE, &wrong_index, &[pixels])
        .err()
        .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract)
    );
  }

  #[test]
  fn point_rectangles_round_outward_and_only_fill_their_pixels() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut contract = request(&pixels);
    let Some(page) = contract.pages.pop() else {
      return;
    };
    let Some(glyph) = page.observation.glyphs.first() else {
      return;
    };
    let mapped = pixel_rect(&page, &glyph.bounds);
    assert!(mapped.is_ok());
    let Ok(mapped) = mapped else {
      return;
    };
    assert_eq!(
      (mapped.left, mapped.top, mapped.right, mapped.bottom),
      (1, 6, 7, 12)
    );
    let mut output = pixels;
    assert!(fill_pixels(&mut output, 17, &[mapped], [0, 0, 0]).is_ok());
    let black_pixels = output
      .chunks_exact(3)
      .filter(|pixel| *pixel == [0, 0, 0])
      .count();
    let white_pixels = output
      .chunks_exact(3)
      .filter(|pixel| *pixel == [255, 255, 255])
      .count();
    assert_eq!(black_pixels, 36);
    assert_eq!(white_pixels, 338);
  }

  #[test]
  fn floating_point_edges_cannot_round_redactions_inward() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut contract = request(&pixels);
    let Some(page) = contract.pages.first_mut() else {
      return;
    };
    let Some(glyph) = page.observation.glyphs.first_mut() else {
      return;
    };
    glyph.bounds.left = 72.0;
    glyph.bounds.right = 108.000_000_000_000_01;
    let bounds = glyph.bounds.clone();

    let mapped = pixel_rect(page, &bounds);
    assert!(mapped.is_ok());
    let Ok(mapped) = mapped else {
      return;
    };

    // 108 points is exactly pixel boundary 3 at this scale. The conservative
    // right edge must include the adjacent pixel even after f64 cancellation.
    assert!(mapped.right >= 4);
  }

  #[test]
  fn provider_identity_fields_are_trimmed_and_control_free() {
    let pixels = vec![255; 17 * 22 * 3];
    for invalid in [" provider", "provider ", "provider\nname"] {
      let mut contract = request(&pixels);
      contract.provider.provider_id = invalid.to_owned();

      let result = rewrite_pdf_raster_from_detections(
        SOURCE,
        &contract,
        std::slice::from_ref(&pixels),
      );
      assert_eq!(
        result.err().map(|failure| failure.code()),
        Some(PdfRasterErrorCode::InvalidContract),
      );
    }
    let mut mixed_language = request(&pixels);
    mixed_language.provider.ocr_language = "eng+deu".to_owned();
    assert_eq!(
      rewrite_pdf_raster_from_detections(
        SOURCE,
        &mixed_language,
        std::slice::from_ref(&pixels),
      )
      .err()
      .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract),
    );
  }
}
