use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, Stream, dictionary};
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
  PdfGlyphObservation, PdfOcrCoverage, PdfPageObservation, PdfRect,
  PdfTextLayerCoverage, inspect_pdf, inspect_pdf_with_observations,
};

pub const PDF_RASTER_CONTRACT_VERSION: u8 = 1;
pub const PDF_RASTER_MAX_PAGE_BYTES: usize = 128 * 1024 * 1024;
pub const PDF_RASTER_MAX_TOTAL_BYTES: usize = 512 * 1024 * 1024;
pub const PDF_RASTER_MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;
const PDF_RASTER_MAX_REDACTIONS: usize = 1_000_000;
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
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterPage {
  pub page_index: u32,
  pub width_points: f64,
  pub height_points: f64,
  pub width_pixels: u32,
  pub height_pixels: u32,
  pub pixel_sha256: String,
  pub rendering: String,
  pub ocr: String,
  pub redactions: Vec<PdfRect>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRasterAnonymization {
  pub contract_version: u8,
  pub source_sha256: String,
  pub provider: PdfRasterProvider,
  pub fill_rgb: [u8; 3],
  pub pages: Vec<PdfRasterPage>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRasterCertificate {
  pub contract_version: u8,
  pub page_count: u32,
  pub redaction_count: u32,
  pub source_sha256: String,
  pub output_sha256: String,
  pub provider: PdfRasterProvider,
  pub output_verified: bool,
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
  ] {
    if value.is_empty() || value.len() > PDF_RASTER_MAX_PROVIDER_FIELD_BYTES {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        format!(
          "PDF raster {label} must contain 1..={PDF_RASTER_MAX_PROVIDER_FIELD_BYTES} UTF-8 bytes"
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

#[derive(Clone, Copy)]
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
  let valid = [rect.left, rect.bottom, rect.right, rect.top]
    .into_iter()
    .all(f64::is_finite)
    && rect.left >= 0.0
    && rect.bottom >= 0.0
    && rect.right > rect.left
    && rect.top > rect.bottom
    && rect.right <= page.width_points
    && rect.top <= page.height_points;
  if !valid {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster redaction rectangle is outside its page",
    ));
  }
  let width = f64::from(page.width_pixels);
  let height = f64::from(page.height_pixels);
  let left = (rect.left / page.width_points * width).floor().to_usize();
  let right = (rect.right / page.width_points * width).ceil().to_usize();
  let top = ((page.height_points - rect.top) / page.height_points * height)
    .floor()
    .to_usize();
  let bottom = ((page.height_points - rect.bottom) / page.height_points
    * height)
    .ceil()
    .to_usize();
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

fn validate_request_header(
  source: &[u8],
  request: &PdfRasterAnonymization,
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
  request: &PdfRasterAnonymization,
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
    if page.page_index != source_index
      || page.rendering != "complete"
      || page.ocr != "complete"
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster pages must be in source order with complete rendering and OCR",
      ));
    }
    if page.width_pixels == 0
      || page.height_pixels == 0
      || !page.width_points.is_finite()
      || !page.height_points.is_finite()
      || page.width_points <= 0.0
      || page.height_points <= 0.0
    {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster page dimensions are invalid",
      ));
    }
    let horizontal_scale = f64::from(page.width_pixels) / page.width_points;
    let vertical_scale = f64::from(page.height_pixels) / page.height_points;
    let scale_difference = (horizontal_scale - vertical_scale).abs();
    let scale_tolerance = horizontal_scale.max(vertical_scale) * 0.001;
    if scale_difference > scale_tolerance {
      return Err(error(
        PdfRasterErrorCode::InvalidContract,
        "PDF raster page pixels must use the same horizontal and vertical scale",
      ));
    }
    if page.redactions.len() > PDF_RASTER_MAX_REDACTIONS {
      return Err(error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster page contains too many redactions",
      ));
    }
    observations.push(PdfPageObservation {
      page_index: page.page_index,
      width_points: page.width_points,
      height_points: page.height_points,
      text: String::new(),
      glyphs: Vec::<PdfGlyphObservation>::new(),
      rendered: true,
      text_layer: PdfTextLayerCoverage::Absent,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    });
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

// Keep the complete output-object allowlist in one auditable pass.
#[allow(clippy::too_many_lines)]
fn verify_output(
  output: &[u8],
  expected_pages: usize,
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
  let inspection = inspect_pdf(output).map_err(|verify_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      verify_error.to_string(),
    )
  })?;
  if usize::try_from(inspection.page_count).ok() != Some(expected_pages)
    || usize::try_from(inspection.risks.image_object_count).ok()
      != Some(expected_pages)
    || inspection.risks.acro_form_field_count != 0
    || inspection.risks.annotation_count != 0
    || inspection.risks.document_info_entry_count != 0
    || inspection.risks.embedded_file_count != 0
    || inspection.risks.external_action_count != 0
    || inspection.risks.incremental_revision_count != 0
    || inspection.risks.javascript_action_count != 0
    || inspection.risks.metadata_stream_count != 0
    || inspection.risks.optional_content_group_count != 0
    || inspection.risks.signature_count != 0
    || inspection.risks.trailing_non_whitespace_byte_count != 0
    || inspection.risks.unsupported_action_count != 0
    || inspection.risks.xfa_entry_count != 0
  {
    return Err(error(
      PdfRasterErrorCode::VerificationFailed,
      "PDF raster output failed the image-only risk inventory",
    ));
  }
  let parsed = Document::load_mem(output).map_err(|verify_error| {
    error(
      PdfRasterErrorCode::VerificationFailed,
      format!("PDF raster output could not be reparsed: {verify_error}"),
    )
  })?;
  let expected_object_count = expected_pages
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
  let mut actual_image_digests = Vec::with_capacity(expected_pages);
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
          let pixels = stream
            .get_plain_content_with_limit(PDF_RASTER_MAX_PAGE_BYTES)
            .map_err(|verify_error| {
              error(
                PdfRasterErrorCode::VerificationFailed,
                format!(
                  "PDF raster image could not be verified: {verify_error}"
                ),
              )
            })?;
          actual_image_digests.push(digest_hex(&pixels));
        } else if object_type == Some(b"XRef".as_slice()) {
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
    || page_count != expected_pages
    || content_stream_count != expected_pages
    || xref_stream_count != 1
    || actual_image_digests != expected_image_digests
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
  pixel_bytes: usize,
  redaction_count: usize,
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
  let rects = page
    .redactions
    .iter()
    .map(|rect| pixel_rect(page, rect))
    .collect::<Result<Vec<_>, _>>()?;
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
    content_bytes(page.width_points, page.height_points)?,
  ));
  let output_page_id = document.add_object(dictionary! {
    "Type" => "Page", "Parent" => page_tree_id,
    "MediaBox" => vec![Object::Integer(0), Object::Integer(0), point_object(page.width_points)?, point_object(page.height_points)?],
    "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
    "Contents" => content_id,
  });
  Ok(AddedRasterPage {
    output_page_id,
    sanitized_digest,
    pixel_bytes: expected,
    redaction_count: rects.len(),
  })
}

/// Destructively fills provider-asserted raster regions and creates a fresh image-only PDF.
/// No object or byte range from the source PDF is copied into the output.
pub fn anonymize_pdf_raster(
  source: &[u8],
  request: &PdfRasterAnonymization,
  page_pixels: &[Vec<u8>],
) -> Result<(Vec<u8>, PdfRasterCertificate), PdfRasterError> {
  validate_source_and_pages(source, request)?;
  if page_pixels.len() != request.pages.len() {
    return Err(error(
      PdfRasterErrorCode::InvalidContract,
      "PDF raster pixel buffers must match the page contract",
    ));
  }
  let mut total_bytes = 0usize;
  let mut redaction_count = 0usize;
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
      supplied_pixels,
      request.fill_rgb,
    )?;
    total_bytes =
      total_bytes.checked_add(added.pixel_bytes).ok_or_else(|| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster total pixel length overflowed",
        )
      })?;
    if total_bytes > PDF_RASTER_MAX_TOTAL_BYTES {
      return Err(error(
        PdfRasterErrorCode::LimitExceeded,
        "PDF raster total pixels exceed their byte limit",
      ));
    }
    redaction_count = redaction_count
      .checked_add(added.redaction_count)
      .ok_or_else(|| {
        error(
          PdfRasterErrorCode::LimitExceeded,
          "PDF raster redaction count overflowed",
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
  verify_output(&output, request.pages.len(), &expected_image_digests)?;
  let page_count = u32::try_from(request.pages.len()).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster page count overflowed",
    )
  })?;
  let redaction_count = u32::try_from(redaction_count).map_err(|_| {
    error(
      PdfRasterErrorCode::LimitExceeded,
      "PDF raster redaction count overflowed",
    )
  })?;
  let certificate = PdfRasterCertificate {
    contract_version: PDF_RASTER_CONTRACT_VERSION,
    page_count,
    redaction_count,
    source_sha256: request.source_sha256.clone(),
    output_sha256: digest_hex(&output),
    provider: request.provider.clone(),
    output_verified: true,
  };
  Ok((output, certificate))
}

#[cfg(test)]
mod tests {
  use super::*;

  const SOURCE: &[u8] = include_bytes!("../tests/fixtures/minimal-text.pdf");

  fn request(pixels: &[u8]) -> PdfRasterAnonymization {
    PdfRasterAnonymization {
      contract_version: PDF_RASTER_CONTRACT_VERSION,
      source_sha256: digest_hex(SOURCE),
      provider: PdfRasterProvider {
        provider_id: "synthetic-test-provider".to_owned(),
        renderer_name: "synthetic-renderer".to_owned(),
        renderer_version: "1.0.0".to_owned(),
        ocr_name: "synthetic-ocr".to_owned(),
        ocr_version: "1.0.0".to_owned(),
      },
      fill_rgb: [0, 0, 0],
      pages: vec![PdfRasterPage {
        page_index: 0,
        width_points: 612.0,
        height_points: 792.0,
        width_pixels: 17,
        height_pixels: 22,
        pixel_sha256: digest_hex(pixels),
        rendering: "complete".to_owned(),
        ocr: "complete".to_owned(),
        redactions: vec![PdfRect {
          left: 72.0,
          bottom: 396.0,
          right: 216.0,
          top: 540.0,
        }],
      }],
    }
  }

  #[test]
  fn creates_verified_fresh_image_only_pdf() {
    let pixels = vec![255; 17 * 22 * 3];
    let result = anonymize_pdf_raster(SOURCE, &request(&pixels), &[pixels]);
    assert!(result.is_ok());
    let Ok((output, certificate)) = result else {
      return;
    };
    assert!(certificate.output_verified);
    assert_eq!(certificate.page_count, 1);
    assert_eq!(certificate.redaction_count, 1);
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
  fn rejects_incomplete_or_mismatched_provider_contracts() {
    let pixels = vec![255; 17 * 22 * 3];
    let mut incomplete = request(&pixels);
    for page in &mut incomplete.pages {
      page.ocr = "partial".to_owned();
    }
    assert_eq!(
      anonymize_pdf_raster(SOURCE, &incomplete, std::slice::from_ref(&pixels),)
        .err()
        .map(|failure| failure.code()),
      Some(PdfRasterErrorCode::InvalidContract)
    );

    let mut wrong_digest = request(&pixels);
    for page in &mut wrong_digest.pages {
      page.pixel_sha256 = "00".repeat(32);
    }
    assert_eq!(
      anonymize_pdf_raster(
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
      anonymize_pdf_raster(SOURCE, &invalid_provider, &[pixels])
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
      anonymize_pdf_raster(&encrypted, &encrypted_request, &[pixels])
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
    assert!(anonymize_pdf_raster(SOURCE, &missing, &[]).is_err());

    let mut invalid_rect = request(&pixels);
    for page in &mut invalid_rect.pages {
      for rect in &mut page.redactions {
        rect.right = 700.0;
      }
    }
    assert!(
      anonymize_pdf_raster(
        SOURCE,
        &invalid_rect,
        std::slice::from_ref(&pixels),
      )
      .is_err()
    );

    let mut wrong_index = request(&pixels);
    let Some(page) = wrong_index.pages.first_mut() else {
      return;
    };
    page.page_index = 1;
    assert_eq!(
      anonymize_pdf_raster(SOURCE, &wrong_index, &[pixels])
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
    let Some(rect) = page.redactions.first() else {
      return;
    };
    let mapped = pixel_rect(&page, rect);
    assert!(mapped.is_ok());
    let Ok(mapped) = mapped else {
      return;
    };
    assert_eq!(
      (mapped.left, mapped.top, mapped.right, mapped.bottom),
      (2, 7, 6, 11)
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
    assert_eq!(black_pixels, 16);
    assert_eq!(white_pixels, 358);
  }
}
