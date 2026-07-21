#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashSet};
use std::fmt;

use lopdf::xref::XrefEntry;
use lopdf::{Dictionary, Document, LoadOptions, Object};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PDF_INSPECTION_CONTRACT_VERSION: u8 = 1;
pub const PDF_OBSERVATION_BATCH_VERSION: u8 = 1;
pub const PDF_DOCUMENT_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_DECOMPRESSED_MAX_BYTES: usize = 128 * 1024 * 1024;
pub const PDF_MAX_OBJECTS: usize = 200_000;
pub const PDF_MAX_OBJECT_NODES: usize = 1_000_000;
pub const PDF_MAX_OBJECT_DEPTH: usize = 128;
pub const PDF_MAX_PAGES: usize = 10_000;
pub const PDF_MAX_GLYPHS: usize = 5_000_000;
pub const PDF_MAX_PAGE_TEXT_UTF8_BYTES: usize = 16 * 1024 * 1024;
pub const PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_MAX_OBSERVATION_JSON_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct PdfInspectionError {
  code: PdfInspectionErrorCode,
  message: String,
}

impl PdfInspectionError {
  #[must_use]
  pub const fn code(&self) -> PdfInspectionErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum PdfInspectionErrorCode {
  DocumentLimitExceeded,
  InvalidDocument,
  InvalidObservation,
  ObservationLimitExceeded,
  ProviderFailed,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRect {
  pub left: f64,
  pub bottom: f64,
  pub right: f64,
  pub top: f64,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfTextLayerCoverage {
  Absent,
  Partial,
  Complete,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfOcrCoverage {
  NotRun,
  Partial,
  Complete,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfGlyphSource {
  EmbeddedText,
  Ocr,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfGlyphObservation {
  /// UTF-16 code-unit offset into the page observation's `text` field.
  pub start: u32,
  /// UTF-16 code-unit offset into the page observation's `text` field.
  pub end: u32,
  pub bounds: PdfRect,
  pub source: PdfGlyphSource,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPageObservation {
  /// Zero-based page index.
  pub page_index: u32,
  pub width_points: f64,
  pub height_points: f64,
  pub text: String,
  pub glyphs: Vec<PdfGlyphObservation>,
  pub rendered: bool,
  pub text_layer: PdfTextLayerCoverage,
  pub ocr: PdfOcrCoverage,
  pub image_count: u32,
}

/// Exact document identity carried by a renderer's observation batch.
#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfObservationDocument {
  /// Lowercase hexadecimal SHA-256 of the exact PDF bytes observed.
  pub sha256: String,
}

/// Renderer identity asserted by the producer of an observation batch.
#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfObservationProvider {
  pub id: String,
  pub name: String,
  pub version: String,
}

/// Strict, document-bound batch of renderer observations.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfObservationBatch {
  pub version: u8,
  pub document: PdfObservationDocument,
  pub provider: PdfObservationProvider,
  pub pages: Vec<PdfPageObservation>,
}

#[derive(Debug, Clone, Copy)]
pub struct PdfPageObservationRequest<'a> {
  pub document: &'a [u8],
  pub page_index: u32,
}

/// Adapter seam for `PDFium` or another renderer/text engine.
///
/// Implementations inspect pixels and glyph geometry; the core remains
/// independent of a renderer and validates every returned observation.
pub trait PdfPageObservationProvider {
  type Error: fmt::Display;

  fn metadata(&self) -> PdfObservationProvider;

  fn observe_page(
    &mut self,
    request: PdfPageObservationRequest<'_>,
  ) -> Result<PdfPageObservation, Self::Error>;
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)]
pub struct PdfRiskInventory {
  pub acro_form_field_count: u32,
  pub annotation_count: u32,
  pub document_info_entry_count: u32,
  /// Embedded-file streams retained inside the PDF.
  pub embedded_file_count: u32,
  pub external_action_count: u32,
  pub image_object_count: u32,
  pub javascript_action_count: u32,
  pub metadata_stream_count: u32,
  pub optional_content_group_count: u32,
  pub signature_count: u32,
  pub xfa_entry_count: u32,
  pub incremental_update_count: u32,
  pub trailing_data_byte_count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfInspectionGap {
  EncryptedDocument,
  ObservationProviderNotIdentified,
  PageContentNotObserved,
  PageNotRendered,
  PartialTextLayer,
  /// Rendered page pixels were not completely covered by OCR. This includes
  /// images, vector outlines, and any other visible content outside the text
  /// layer.
  UnobservedVisualContent,
  RetainedDocumentBytes,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfInspectionCoverageStatus {
  ProviderAttestedFull,
  Partial,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInspectionCoverage {
  pub status: PdfInspectionCoverageStatus,
  pub gaps: Vec<PdfInspectionGap>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageInspection {
  pub page_index: u32,
  pub annotation_count: u32,
  pub observation: Option<PdfPageObservation>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInspection {
  pub contract_version: u8,
  pub pdf_version: String,
  pub byte_length: u64,
  pub object_count: u32,
  pub page_count: u32,
  pub encrypted: bool,
  pub observation_provider: Option<PdfObservationProvider>,
  pub pages: Vec<PdfPageInspection>,
  pub risks: PdfRiskInventory,
  pub coverage: PdfInspectionCoverage,
}

#[must_use]
fn error(
  code: PdfInspectionErrorCode,
  message: impl Into<String>,
) -> PdfInspectionError {
  PdfInspectionError {
    code,
    message: message.into(),
  }
}

pub fn inspect_pdf(
  document: &[u8],
) -> Result<PdfInspection, PdfInspectionError> {
  let parsed = parse_document(document)?;
  inspect_parsed(document, parsed, Vec::new(), None)
}

pub fn inspect_pdf_with_provider<P: PdfPageObservationProvider>(
  document: &[u8],
  provider: &mut P,
) -> Result<PdfInspection, PdfInspectionError> {
  let parsed = parse_document(document)?;
  let provider_metadata = provider.metadata();
  validate_provider(&provider_metadata)?;
  let page_count = validated_pages(&parsed)?.len();
  let mut observations = Vec::with_capacity(page_count);
  for page_index in 0..page_count {
    let page_index = u32::try_from(page_index).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF page index overflowed",
      )
    })?;
    observations.push(
      provider
        .observe_page(PdfPageObservationRequest {
          document,
          page_index,
        })
        .map_err(|provider_error| {
          error(
            PdfInspectionErrorCode::ProviderFailed,
            format!("PDF page observation provider failed: {provider_error}"),
          )
        })?,
    );
  }
  inspect_parsed(document, parsed, observations, Some(provider_metadata))
}

pub fn inspect_pdf_with_observations(
  document: &[u8],
  batch: PdfObservationBatch,
) -> Result<PdfInspection, PdfInspectionError> {
  let parsed = parse_document(document)?;
  validate_observation_batch(document, &batch)?;
  inspect_parsed(document, parsed, batch.pages, Some(batch.provider))
}

fn validate_observation_batch(
  document: &[u8],
  batch: &PdfObservationBatch,
) -> Result<(), PdfInspectionError> {
  if batch.version != PDF_OBSERVATION_BATCH_VERSION {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      format!(
        "PDF observation batch version must be {PDF_OBSERVATION_BATCH_VERSION}"
      ),
    ));
  }
  let expected = sha256_lower_hex(document);
  if batch.document.sha256 != expected {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      "PDF observation batch SHA-256 does not match the exact document bytes",
    ));
  }
  validate_provider(&batch.provider)
}

fn sha256_lower_hex(bytes: &[u8]) -> String {
  let digest = Sha256::digest(bytes);
  let mut encoded = String::with_capacity(64);
  for byte in digest {
    encoded.push(hex_digit(byte >> 4));
    encoded.push(hex_digit(byte & 0x0f));
  }
  encoded
}

const fn hex_digit(nibble: u8) -> char {
  match nibble {
    0 => '0',
    1 => '1',
    2 => '2',
    3 => '3',
    4 => '4',
    5 => '5',
    6 => '6',
    7 => '7',
    8 => '8',
    9 => '9',
    10 => 'a',
    11 => 'b',
    12 => 'c',
    13 => 'd',
    14 => 'e',
    15 => 'f',
    _ => '?',
  }
}

fn validate_provider(
  provider: &PdfObservationProvider,
) -> Result<(), PdfInspectionError> {
  for (label, value) in [
    ("id", provider.id.as_str()),
    ("name", provider.name.as_str()),
    ("version", provider.version.as_str()),
  ] {
    if value.trim().is_empty()
      || value.trim() != value
      || value.len() > 256
      || value.chars().any(char::is_control)
    {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        format!(
          "PDF observation provider {label} must contain 1 to 256 trimmed UTF-8 bytes without control characters"
        ),
      ));
    }
  }
  Ok(())
}

fn parse_document(document: &[u8]) -> Result<Document, PdfInspectionError> {
  if document.len() > PDF_DOCUMENT_MAX_BYTES {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!("PDF documents must not exceed {PDF_DOCUMENT_MAX_BYTES} bytes"),
    ));
  }
  validate_supported_pdf_header(document)?;
  let parsed = Document::load_mem_with_options(
    document,
    LoadOptions {
      strict: true,
      max_decompressed_size: Some(PDF_DECOMPRESSED_MAX_BYTES),
      ..Default::default()
    },
  )
  .map_err(|parse_error| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      format!(
        "PDF document is invalid or exceeds decompression limits: {parse_error}"
      ),
    )
  })?;
  validate_loaded_object_table(&parsed)?;
  validate_all_indirect_references(&parsed)?;
  validate_supported_object_kinds(&parsed)?;
  if parsed.objects.len() > PDF_MAX_OBJECTS {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF documents must not contain more than {PDF_MAX_OBJECTS} objects"
      ),
    ));
  }
  Ok(parsed)
}

fn validate_supported_pdf_header(
  document: &[u8],
) -> Result<(), PdfInspectionError> {
  let header = document.get(..8).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF header is missing",
    )
  })?;
  if !matches!(
    header,
    b"%PDF-1.0" | b"%PDF-1.1" | b"%PDF-1.2" | b"%PDF-1.3" | b"%PDF-1.4"
  ) {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "strict PDF inspection supports classic PDF versions 1.0 through 1.4 only",
    ));
  }
  Ok(())
}

fn validate_loaded_object_table(
  document: &Document,
) -> Result<(), PdfInspectionError> {
  let complete = document.reference_table.entries.iter().all(
    |(number, entry)| match entry {
      XrefEntry::Free | XrefEntry::UnusableFree => true,
      XrefEntry::Normal { generation, .. } => {
        document.objects.contains_key(&(*number, *generation))
      }
      XrefEntry::Compressed { .. } => {
        document.objects.contains_key(&(*number, 0))
      }
    },
  );
  if complete {
    Ok(())
  } else {
    Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF object table could not be fully loaded within parser limits",
    ))
  }
}

fn validate_all_indirect_references(
  document: &Document,
) -> Result<(), PdfInspectionError> {
  let mut visited = HashSet::new();
  let mut active = HashSet::new();
  let mut nodes = 0usize;
  validate_object_references(
    document,
    &Object::Dictionary(document.trailer.clone()),
    0,
    &mut nodes,
    &mut visited,
    &mut active,
  )?;
  for id in document.objects.keys().copied() {
    validate_indirect_reference(
      document,
      id,
      0,
      &mut nodes,
      &mut visited,
      &mut active,
    )?;
  }
  Ok(())
}

fn validate_indirect_reference(
  document: &Document,
  id: lopdf::ObjectId,
  depth: usize,
  nodes: &mut usize,
  visited: &mut HashSet<lopdf::ObjectId>,
  active: &mut HashSet<lopdf::ObjectId>,
) -> Result<(), PdfInspectionError> {
  let object = document.objects.get(&id).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      format!(
        "PDF contains a dangling indirect reference to {} {} R",
        id.0, id.1
      ),
    )
  })?;
  if visited.contains(&id) || !active.insert(id) {
    return Ok(());
  }
  validate_object_references(document, object, depth, nodes, visited, active)?;
  active.remove(&id);
  visited.insert(id);
  Ok(())
}

fn validate_object_references(
  document: &Document,
  object: &Object,
  depth: usize,
  nodes: &mut usize,
  visited: &mut HashSet<lopdf::ObjectId>,
  active: &mut HashSet<lopdf::ObjectId>,
) -> Result<(), PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF object references must not exceed {PDF_MAX_OBJECT_DEPTH} levels"
      ),
    ));
  }
  *nodes = nodes.checked_add(1).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF object node count overflowed",
    )
  })?;
  if *nodes > PDF_MAX_OBJECT_NODES {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF documents must not contain more than {PDF_MAX_OBJECT_NODES} object nodes"
      ),
    ));
  }
  let next_depth = depth.checked_add(1).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF object reference depth overflowed",
    )
  })?;
  match object {
    Object::Reference(id) => validate_indirect_reference(
      document, *id, next_depth, nodes, visited, active,
    ),
    Object::Array(values) => {
      for value in values {
        validate_object_references(
          document, value, next_depth, nodes, visited, active,
        )?;
      }
      Ok(())
    }
    Object::Dictionary(dictionary) => {
      for (_, value) in dictionary {
        validate_object_references(
          document, value, next_depth, nodes, visited, active,
        )?;
      }
      Ok(())
    }
    Object::Stream(stream) => {
      for (_, value) in &stream.dict {
        validate_object_references(
          document, value, next_depth, nodes, visited, active,
        )?;
      }
      Ok(())
    }
    _ => Ok(()),
  }
}

fn validate_supported_object_kinds(
  document: &Document,
) -> Result<(), PdfInspectionError> {
  let catalog = document.catalog().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF catalog is missing",
    )
  })?;
  if let Ok(version) = catalog.get(b"Version") {
    let version = version.as_name().map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF catalog Version must be a name",
      )
    })?;
    if !matches!(version, b"1.0" | b"1.1" | b"1.2" | b"1.3" | b"1.4") {
      return Err(error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF catalog version is outside the strict inspection contract",
      ));
    }
  }
  if document.objects.values().any(|object| {
    object_dictionary(object).is_some_and(|dict| {
      name_is(dict, b"Type", b"ObjStm") || name_is(dict, b"Type", b"XRef")
    })
  }) {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "object streams and cross-reference streams are outside the strict inspection contract",
    ));
  }
  Ok(())
}

#[derive(Clone, Copy)]
struct ValidatedPage {
  id: lopdf::ObjectId,
  width: f64,
  height: f64,
}

fn validated_pages(
  document: &Document,
) -> Result<Vec<ValidatedPage>, PdfInspectionError> {
  let catalog = document.catalog().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF catalog is missing",
    )
  })?;
  let root = catalog
    .get(b"Pages")
    .and_then(Object::as_reference)
    .map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF catalog Pages entry must reference a page tree",
      )
    })?;
  let mut ids = Vec::new();
  walk_page_tree(document, root, None, 0, &mut HashSet::new(), &mut ids)?;
  ids
    .into_iter()
    .map(|id| {
      let (width, height) = page_geometry(document, id, root)?;
      Ok(ValidatedPage { id, width, height })
    })
    .collect()
}

fn walk_page_tree(
  document: &Document,
  id: lopdf::ObjectId,
  expected_parent: Option<lopdf::ObjectId>,
  depth: usize,
  seen: &mut HashSet<lopdf::ObjectId>,
  pages: &mut Vec<lopdf::ObjectId>,
) -> Result<usize, PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH || !seen.insert(id) {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page tree is cyclic or exceeds the nesting limit",
    ));
  }
  let dict = document.get_dictionary(id).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page tree contains an invalid reference",
    )
  })?;
  if let Some(parent) = expected_parent
    && dict.get(b"Parent").and_then(Object::as_reference).ok() != Some(parent)
  {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page tree Parent reference is inconsistent",
    ));
  }
  if name_is(dict, b"Type", b"Page") {
    pages.push(id);
    if pages.len() > PDF_MAX_PAGES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        format!(
          "PDF documents must not contain more than {PDF_MAX_PAGES} pages"
        ),
      ));
    }
    return Ok(1);
  }
  if !name_is(dict, b"Type", b"Pages") {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page tree node has an invalid Type",
    ));
  }
  let kids = dict.get(b"Kids").and_then(Object::as_array).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF Pages node Kids must be an array",
    )
  })?;
  let mut actual = 0usize;
  for kid in kids {
    let kid = kid.as_reference().map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF page tree Kids must contain references",
      )
    })?;
    actual = actual
      .checked_add(walk_page_tree(
        document,
        kid,
        Some(id),
        depth.checked_add(1).ok_or_else(|| {
          error(
            PdfInspectionErrorCode::DocumentLimitExceeded,
            "PDF page tree depth overflowed",
          )
        })?,
        seen,
        pages,
      )?)
      .ok_or_else(|| {
        error(
          PdfInspectionErrorCode::DocumentLimitExceeded,
          "PDF page count overflowed",
        )
      })?;
  }
  let declared = dict
    .get(b"Count")
    .and_then(Object::as_i64)
    .ok()
    .and_then(|v| usize::try_from(v).ok())
    .ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF Pages node Count is missing or invalid",
      )
    })?;
  if declared != actual {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF Pages node Count does not match its descendants",
    ));
  }
  Ok(actual)
}

fn page_geometry(
  document: &Document,
  page: lopdf::ObjectId,
  root: lopdf::ObjectId,
) -> Result<(f64, f64), PdfInspectionError> {
  let mut id = page;
  let (mut media, mut crop, mut rotation) = (None, None, None);
  for _ in 0..=PDF_MAX_OBJECT_DEPTH {
    let dict = document.get_dictionary(id).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF page geometry reference is invalid",
      )
    })?;
    media = media.or_else(|| dict.get(b"MediaBox").ok());
    crop = crop.or_else(|| dict.get(b"CropBox").ok());
    rotation = rotation.or_else(|| dict.get(b"Rotate").ok());
    if id == root {
      let media = parse_page_box(
        document,
        media.ok_or_else(|| {
          error(
            PdfInspectionErrorCode::InvalidDocument,
            "PDF page has no inherited MediaBox",
          )
        })?,
      )?;
      let rect = if let Some(crop) = crop {
        parse_page_box(document, crop)?
      } else {
        media
      };
      if rect.0 < media.0
        || rect.1 < media.1
        || rect.2 > media.2
        || rect.3 > media.3
      {
        return Err(error(
          PdfInspectionErrorCode::InvalidDocument,
          "PDF CropBox must be contained by its MediaBox",
        ));
      }
      let rotate = rotation.map_or(Ok(0), |value| {
        document
          .dereference(value)
          .and_then(|(_, value)| value.as_i64())
          .map_err(|_| {
            error(
              PdfInspectionErrorCode::InvalidDocument,
              "PDF page Rotate must be an integer",
            )
          })
      })?;
      if !matches!(rotate.rem_euclid(360), 0 | 90 | 180 | 270) {
        return Err(error(
          PdfInspectionErrorCode::InvalidDocument,
          "PDF page Rotate must be a multiple of 90",
        ));
      }
      let size = (rect.2 - rect.0, rect.3 - rect.1);
      return Ok(if matches!(rotate.rem_euclid(360), 90 | 270) {
        (size.1, size.0)
      } else {
        size
      });
    }
    id = dict
      .get(b"Parent")
      .and_then(Object::as_reference)
      .map_err(|_| {
        error(
          PdfInspectionErrorCode::InvalidDocument,
          "PDF page has an invalid inherited geometry chain",
        )
      })?;
  }
  Err(error(
    PdfInspectionErrorCode::InvalidDocument,
    "PDF page geometry inheritance exceeds the nesting limit",
  ))
}

fn parse_page_box(
  document: &Document,
  object: &Object,
) -> Result<(f64, f64, f64, f64), PdfInspectionError> {
  let (_, object) = document.dereference(object).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page box reference is invalid",
    )
  })?;
  let values = object.as_array().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page box must be an array",
    )
  })?;
  if values.len() != 4 {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page box must contain four numbers",
    ));
  }
  let number = |value: &Object| {
    value.as_float().map(f64::from).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF page box must contain numbers",
      )
    })
  };
  let [left, bottom, right, top] = values.as_slice() else {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page box must contain four numbers",
    ));
  };
  let rect = (number(left)?, number(bottom)?, number(right)?, number(top)?);
  if !rect.0.is_finite()
    || !rect.1.is_finite()
    || !rect.2.is_finite()
    || !rect.3.is_finite()
    || rect.0 >= rect.2
    || rect.1 >= rect.3
  {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page box must be finite and non-empty",
    ));
  }
  Ok(rect)
}

fn inspect_parsed(
  bytes: &[u8],
  document: Document,
  observations: Vec<PdfPageObservation>,
  observation_provider: Option<PdfObservationProvider>,
) -> Result<PdfInspection, PdfInspectionError> {
  if document.is_encrypted() {
    return Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "encrypted PDF documents cannot be inspected safely",
    ));
  }
  let pages = validated_pages(&document)?;
  if observations.len() > pages.len() {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      "PDF page observations exceed the document page count",
    ));
  }
  let observations = validate_observations(observations, &pages)?;
  let mut risks = risk_inventory(&document, &pages)?;
  risks.incremental_update_count = incremental_update_count(bytes)?;
  risks.trailing_data_byte_count = trailing_data_byte_count(bytes)?;
  let mut page_inspections = Vec::with_capacity(pages.len());
  for (page_offset, page) in pages.iter().enumerate() {
    let page_index = u32::try_from(page_offset).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF page index overflowed",
      )
    })?;
    let annotation_count = annotation_count(&document, page.id)?;
    page_inspections.push(PdfPageInspection {
      page_index,
      annotation_count,
      observation: observations
        .iter()
        .find(|observation| observation.page_index == page_index)
        .cloned(),
    });
  }
  let encrypted = false;
  let coverage = coverage(
    encrypted,
    observation_provider.is_some(),
    &page_inspections,
    &risks,
  );
  Ok(PdfInspection {
    contract_version: PDF_INSPECTION_CONTRACT_VERSION,
    pdf_version: document.version,
    byte_length: u64::try_from(bytes.len()).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF byte length overflowed",
      )
    })?,
    object_count: u32::try_from(document.objects.len()).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF object count overflowed",
      )
    })?,
    page_count: u32::try_from(pages.len()).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF page count overflowed",
      )
    })?,
    encrypted,
    observation_provider,
    pages: page_inspections,
    risks,
    coverage,
  })
}

fn validate_observations(
  mut observations: Vec<PdfPageObservation>,
  pages: &[ValidatedPage],
) -> Result<Vec<PdfPageObservation>, PdfInspectionError> {
  observations.sort_by_key(|observation| observation.page_index);
  let mut seen = BTreeSet::new();
  let mut glyph_count = 0usize;
  let mut text_bytes = 0usize;
  for observation in &observations {
    let page_index = usize::try_from(observation.page_index).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observation page index overflowed",
      )
    })?;
    if page_index >= pages.len() || !seen.insert(observation.page_index) {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observations must identify each existing page at most once",
      ));
    }
    if observation.text.len() > PDF_MAX_PAGE_TEXT_UTF8_BYTES {
      return Err(error(
        PdfInspectionErrorCode::ObservationLimitExceeded,
        format!(
          "PDF observed page text must not exceed {PDF_MAX_PAGE_TEXT_UTF8_BYTES} UTF-8 bytes"
        ),
      ));
    }
    text_bytes =
      text_bytes
        .checked_add(observation.text.len())
        .ok_or_else(|| {
          error(
            PdfInspectionErrorCode::ObservationLimitExceeded,
            "PDF observation text byte count overflowed",
          )
        })?;
    if text_bytes > PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES {
      return Err(error(
        PdfInspectionErrorCode::ObservationLimitExceeded,
        format!(
          "PDF observation text must not exceed {PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES} UTF-8 bytes in aggregate"
        ),
      ));
    }
    validate_dimension(observation.width_points, "width")?;
    validate_dimension(observation.height_points, "height")?;
    let expected = *pages.get(page_index).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observation page does not exist",
      )
    })?;
    if (observation.width_points - expected.width).abs() > 0.01
      || (observation.height_points - expected.height).abs() > 0.01
    {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observation dimensions must match the effective rotated CropBox",
      ));
    }
    validate_glyph_boundaries(observation)?;
    let mut previous_end = 0;
    for glyph in &observation.glyphs {
      if glyph.start >= glyph.end || glyph.start < previous_end {
        return Err(error(
          PdfInspectionErrorCode::InvalidObservation,
          "PDF glyph spans must be non-empty, ordered, and non-overlapping",
        ));
      }
      validate_rect(&glyph.bounds, observation)?;
      previous_end = glyph.end;
    }
    validate_glyph_coverage(observation)?;
    glyph_count = glyph_count
      .checked_add(observation.glyphs.len())
      .ok_or_else(|| {
        error(
          PdfInspectionErrorCode::ObservationLimitExceeded,
          "PDF glyph observation count overflowed",
        )
      })?;
    validate_glyph_count(glyph_count)?;
  }
  Ok(observations)
}

fn validate_glyph_count(glyph_count: usize) -> Result<(), PdfInspectionError> {
  if glyph_count <= PDF_MAX_GLYPHS {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::ObservationLimitExceeded,
    format!(
      "PDF observations must not contain more than {PDF_MAX_GLYPHS} glyphs"
    ),
  ))
}

fn validate_dimension(
  value: f64,
  name: &str,
) -> Result<(), PdfInspectionError> {
  if value.is_finite() && value > 0.0 {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::InvalidObservation,
    format!("PDF observed page {name} must be finite and positive"),
  ))
}

fn validate_rect(
  rect: &PdfRect,
  page: &PdfPageObservation,
) -> Result<(), PdfInspectionError> {
  let values = [rect.left, rect.bottom, rect.right, rect.top];
  if values.iter().any(|value| !value.is_finite())
    || rect.left < 0.0
    || rect.bottom < 0.0
    || rect.left >= rect.right
    || rect.bottom >= rect.top
    || rect.right > page.width_points
    || rect.top > page.height_points
  {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      "PDF glyph bounds must be finite, non-empty, and inside the page",
    ));
  }
  Ok(())
}

fn validate_glyph_boundaries(
  observation: &PdfPageObservation,
) -> Result<(), PdfInspectionError> {
  let mut characters = observation.text.chars();
  let mut offset = 0u32;
  for glyph in &observation.glyphs {
    for target in [glyph.start, glyph.end] {
      while offset < target {
        let character = characters.next().ok_or_else(|| {
          error(
            PdfInspectionErrorCode::InvalidObservation,
            "PDF glyph span exceeds observed text",
          )
        })?;
        let width = u32::try_from(character.len_utf16()).map_err(|_| {
          error(
            PdfInspectionErrorCode::InvalidObservation,
            "PDF observed text offset overflowed",
          )
        })?;
        offset = offset.checked_add(width).ok_or_else(|| {
          error(
            PdfInspectionErrorCode::InvalidObservation,
            "PDF observed text offset overflowed",
          )
        })?;
      }
      if offset != target {
        return Err(error(
          PdfInspectionErrorCode::InvalidObservation,
          "PDF glyph spans must use valid UTF-16 code-unit boundaries",
        ));
      }
    }
  }
  Ok(())
}

fn validate_glyph_coverage(
  observation: &PdfPageObservation,
) -> Result<(), PdfInspectionError> {
  let (mut offset, mut glyph_index) = (0u32, 0usize);
  for character in observation.text.chars() {
    let start = offset;
    let width = u32::try_from(character.len_utf16()).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observed text offset overflowed",
      )
    })?;
    offset = offset.checked_add(width).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observed text offset overflowed",
      )
    })?;
    if character.is_whitespace() {
      continue;
    }
    while observation
      .glyphs
      .get(glyph_index)
      .is_some_and(|glyph| glyph.end <= start)
    {
      glyph_index = glyph_index.checked_add(1).ok_or_else(|| {
        error(
          PdfInspectionErrorCode::ObservationLimitExceeded,
          "PDF glyph index overflowed",
        )
      })?;
    }
    let glyph = observation.glyphs.get(glyph_index).ok_or_else(|| error(PdfInspectionErrorCode::InvalidObservation, "PDF observations must provide glyph geometry for every non-whitespace character"))?;
    if glyph.start > start || glyph.end < offset {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observations must provide glyph geometry for every non-whitespace character",
      ));
    }
    let valid_source = match glyph.source {
      PdfGlyphSource::EmbeddedText => {
        observation.text_layer != PdfTextLayerCoverage::Absent
      }
      PdfGlyphSource::Ocr => observation.ocr != PdfOcrCoverage::NotRun,
    };
    if !valid_source {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF glyph source conflicts with declared page coverage",
      ));
    }
  }
  Ok(())
}

fn coverage(
  encrypted: bool,
  provider_identified: bool,
  pages: &[PdfPageInspection],
  risks: &PdfRiskInventory,
) -> PdfInspectionCoverage {
  let mut gaps = BTreeSet::new();
  if encrypted {
    gaps.insert(PdfInspectionGap::EncryptedDocument);
  }
  if risks.incremental_update_count > 0 || risks.trailing_data_byte_count > 0 {
    gaps.insert(PdfInspectionGap::RetainedDocumentBytes);
  }
  if !provider_identified {
    gaps.insert(PdfInspectionGap::ObservationProviderNotIdentified);
  }
  for page in pages {
    let Some(observation) = &page.observation else {
      gaps.insert(PdfInspectionGap::PageContentNotObserved);
      continue;
    };
    if !observation.rendered {
      gaps.insert(PdfInspectionGap::PageNotRendered);
    }
    if observation.text_layer != PdfTextLayerCoverage::Complete {
      gaps.insert(PdfInspectionGap::PartialTextLayer);
    }
    if observation.ocr != PdfOcrCoverage::Complete {
      gaps.insert(PdfInspectionGap::UnobservedVisualContent);
    }
  }
  let gaps = gaps.into_iter().collect::<Vec<_>>();
  PdfInspectionCoverage {
    status: if gaps.is_empty() {
      PdfInspectionCoverageStatus::ProviderAttestedFull
    } else {
      PdfInspectionCoverageStatus::Partial
    },
    gaps,
  }
}

impl Ord for PdfInspectionGap {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    gap_rank(self).cmp(&gap_rank(other))
  }
}

impl PartialOrd for PdfInspectionGap {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

const fn gap_rank(gap: &PdfInspectionGap) -> u8 {
  match gap {
    PdfInspectionGap::EncryptedDocument => 0,
    PdfInspectionGap::ObservationProviderNotIdentified => 1,
    PdfInspectionGap::PageContentNotObserved => 2,
    PdfInspectionGap::PageNotRendered => 3,
    PdfInspectionGap::PartialTextLayer => 4,
    PdfInspectionGap::UnobservedVisualContent => 5,
    PdfInspectionGap::RetainedDocumentBytes => 6,
  }
}

fn risk_inventory(
  document: &Document,
  pages: &[ValidatedPage],
) -> Result<PdfRiskInventory, PdfInspectionError> {
  let mut inventory = PdfRiskInventory {
    acro_form_field_count: 0,
    annotation_count: 0,
    document_info_entry_count: info_entry_count(document)?,
    embedded_file_count: 0,
    external_action_count: 0,
    image_object_count: 0,
    javascript_action_count: 0,
    metadata_stream_count: 0,
    optional_content_group_count: 0,
    signature_count: 0,
    xfa_entry_count: catalog_xfa_count(document)?,
    incremental_update_count: 0,
    trailing_data_byte_count: 0,
  };
  let mut scanned_nodes = 0usize;
  for object in document.objects.values() {
    scan_risk_object(object, &mut inventory, 0, &mut scanned_nodes)?;
  }
  for page in pages {
    let count = annotation_count(document, page.id)?;
    inventory.annotation_count =
      inventory.annotation_count.saturating_add(count);
  }
  Ok(inventory)
}

fn scan_risk_object(
  object: &Object,
  inventory: &mut PdfRiskInventory,
  depth: usize,
  scanned_nodes: &mut usize,
) -> Result<(), PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF objects must not be nested deeper than {PDF_MAX_OBJECT_DEPTH} levels"
      ),
    ));
  }
  *scanned_nodes = scanned_nodes.checked_add(1).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF object node count overflowed",
    )
  })?;
  if *scanned_nodes > PDF_MAX_OBJECT_NODES {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF documents must not contain more than {PDF_MAX_OBJECT_NODES} object nodes"
      ),
    ));
  }
  if let Some(dictionary) = object_dictionary(object) {
    if dictionary.get(b"FT").is_ok() {
      increment(&mut inventory.acro_form_field_count);
    }
    if name_is(dictionary, b"Type", b"EmbeddedFile") {
      increment(&mut inventory.embedded_file_count);
    }
    if name_is(dictionary, b"Subtype", b"Image") {
      increment(&mut inventory.image_object_count);
    }
    if name_is(dictionary, b"Type", b"Metadata") {
      increment(&mut inventory.metadata_stream_count);
    }
    if name_is(dictionary, b"Type", b"OCG") {
      increment(&mut inventory.optional_content_group_count);
    }
    if name_is(dictionary, b"FT", b"Sig")
      || name_is(dictionary, b"Type", b"Sig")
    {
      increment(&mut inventory.signature_count);
    }
    if name_is(dictionary, b"S", b"JavaScript") || dictionary.get(b"JS").is_ok()
    {
      increment(&mut inventory.javascript_action_count);
    }
    if [
      b"URI".as_slice(),
      b"Launch",
      b"GoToR",
      b"SubmitForm",
      b"ImportData",
    ]
    .iter()
    .any(|action| name_is(dictionary, b"S", action))
    {
      increment(&mut inventory.external_action_count);
    }
    for (_, value) in dictionary {
      scan_risk_object(
        value,
        inventory,
        depth.saturating_add(1),
        scanned_nodes,
      )?;
    }
  }
  if let Object::Array(values) = object {
    for value in values {
      scan_risk_object(
        value,
        inventory,
        depth.saturating_add(1),
        scanned_nodes,
      )?;
    }
  }
  Ok(())
}

const fn increment(value: &mut u32) {
  *value = value.saturating_add(1);
}

const fn object_dictionary(object: &Object) -> Option<&Dictionary> {
  match object {
    Object::Dictionary(dictionary) => Some(dictionary),
    Object::Stream(stream) => Some(&stream.dict),
    _ => None,
  }
}

fn name_is(dictionary: &Dictionary, key: &[u8], expected: &[u8]) -> bool {
  dictionary
    .get(key)
    .ok()
    .and_then(|object| object.as_name().ok())
    .is_some_and(|name| name == expected)
}

fn annotation_count(
  document: &Document,
  page_id: lopdf::ObjectId,
) -> Result<u32, PdfInspectionError> {
  let page = document.get_dictionary(page_id).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page dictionary is invalid",
    )
  })?;
  let Ok(raw) = page.get(b"Annots") else {
    return Ok(0);
  };
  let (_, object) = document.dereference(raw).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page Annots reference is invalid",
    )
  })?;
  let annotations = object.as_array().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF page Annots must be an array",
    )
  })?;
  for annotation in annotations {
    let (_, annotation) = document.dereference(annotation).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF annotation reference is invalid",
      )
    })?;
    annotation.as_dict().map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF annotation must be a dictionary",
      )
    })?;
  }
  u32::try_from(annotations.len()).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF annotation count overflowed",
    )
  })
}

fn info_entry_count(document: &Document) -> Result<u32, PdfInspectionError> {
  let Ok(raw) = document.trailer.get(b"Info") else {
    return Ok(0);
  };
  let (_, info) = document.dereference(raw).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF Info reference is invalid",
    )
  })?;
  let info = info.as_dict().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF Info entry must be a dictionary",
    )
  })?;
  u32::try_from(info.len()).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF Info entry count overflowed",
    )
  })
}

fn catalog_xfa_count(document: &Document) -> Result<u32, PdfInspectionError> {
  let catalog = document.catalog().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF catalog is missing",
    )
  })?;
  let Ok(raw_form) = catalog.get(b"AcroForm") else {
    return Ok(0);
  };
  let (_, form) = document.dereference(raw_form).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF AcroForm reference is invalid",
    )
  })?;
  let form = form.as_dict().map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF AcroForm must be a dictionary",
    )
  })?;
  let Ok(raw_xfa) = form.get(b"XFA") else {
    return Ok(0);
  };
  let (_, xfa) = document.dereference(raw_xfa).map_err(|_| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF XFA reference is invalid",
    )
  })?;
  match xfa {
    Object::Stream(_) => Ok(1),
    Object::Array(packets) if packets.len() % 2 == 0 => {
      for packet in packets.chunks_exact(2) {
        let [name, contents] = packet else {
          return Err(error(
            PdfInspectionErrorCode::InvalidDocument,
            "PDF XFA packet is malformed",
          ));
        };
        name.as_str().map_err(|_| {
          error(
            PdfInspectionErrorCode::InvalidDocument,
            "PDF XFA packet name must be a string",
          )
        })?;
        let (_, contents) = document.dereference(contents).map_err(|_| {
          error(
            PdfInspectionErrorCode::InvalidDocument,
            "PDF XFA packet reference is invalid",
          )
        })?;
        if !matches!(contents, Object::Stream(_)) {
          return Err(error(
            PdfInspectionErrorCode::InvalidDocument,
            "PDF XFA packet contents must be a stream",
          ));
        }
      }
      u32::try_from(packets.chunks_exact(2).count()).map_err(|_| {
        error(
          PdfInspectionErrorCode::DocumentLimitExceeded,
          "PDF XFA packet count overflowed",
        )
      })
    }
    _ => Err(error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF XFA entry must be a stream or packet array",
    )),
  }
}

fn incremental_update_count(bytes: &[u8]) -> Result<u32, PdfInspectionError> {
  let count = bytes
    .windows(b"startxref".len())
    .filter(|window| *window == b"startxref")
    .count()
    .saturating_sub(1);
  u32::try_from(count).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF incremental revision count overflowed",
    )
  })
}

fn trailing_data_byte_count(bytes: &[u8]) -> Result<u64, PdfInspectionError> {
  let startxref = b"startxref";
  let marker = b"%%EOF";
  let revision_start = bytes
    .windows(startxref.len())
    .rposition(|window| window == startxref)
    .ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF final startxref marker is missing",
      )
    })?;
  let revision = bytes.get(revision_start..).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF final revision offset is invalid",
    )
  })?;
  let relative_marker = revision
    .windows(marker.len())
    .position(|window| window == marker)
    .ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidDocument,
        "PDF final EOF marker is missing",
      )
    })?;
  let marker_start =
    revision_start.checked_add(relative_marker).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF EOF offset overflowed",
      )
    })?;
  let start = marker_start.checked_add(marker.len()).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF EOF offset overflowed",
    )
  })?;
  let trailing = bytes.get(start..).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::InvalidDocument,
      "PDF EOF offset is invalid",
    )
  })?;
  let count = trailing
    .iter()
    .filter(|byte| !byte.is_ascii_whitespace())
    .count();
  u64::try_from(count).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF trailing data byte count overflowed",
    )
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::*;

  const MINIMAL_PDF: &[u8] =
    include_bytes!("../tests/fixtures/minimal-text.pdf");
  const RISKY_PDF: &[u8] =
    include_bytes!("../tests/fixtures/risky-structures.pdf");
  const ENCRYPTED_PDF: &[u8] =
    include_bytes!("../tests/fixtures/encrypted.pdf");

  fn observation_batch(
    document: &[u8],
    pages: Vec<PdfPageObservation>,
  ) -> PdfObservationBatch {
    PdfObservationBatch {
      version: PDF_OBSERVATION_BATCH_VERSION,
      document: PdfObservationDocument {
        sha256: sha256_lower_hex(document),
      },
      provider: PdfObservationProvider {
        id: String::from("test-renderer"),
        name: String::from("Test Renderer"),
        version: String::from("1.0.0"),
      },
      pages,
    }
  }

  fn complete_minimal_observation() -> PdfPageObservation {
    serde_json::from_str(include_str!(
      "../tests/fixtures/minimal-text-observation.json"
    ))
    .unwrap()
  }

  #[test]
  fn inspection_without_a_renderer_is_explicitly_partial() {
    let inspection = inspect_pdf(MINIMAL_PDF).unwrap();
    assert_eq!(inspection.contract_version, 1);
    assert_eq!(inspection.page_count, 1);
    assert_eq!(
      inspection.coverage.status,
      PdfInspectionCoverageStatus::Partial
    );
    assert_eq!(
      inspection.coverage.gaps,
      vec![
        PdfInspectionGap::ObservationProviderNotIdentified,
        PdfInspectionGap::PageContentNotObserved,
      ]
    );
  }

  #[test]
  fn complete_renderer_observation_can_close_inspection_coverage() {
    let inspection = inspect_pdf_with_observations(
      MINIMAL_PDF,
      observation_batch(MINIMAL_PDF, vec![complete_minimal_observation()]),
    )
    .unwrap();
    assert_eq!(
      inspection.coverage.status,
      PdfInspectionCoverageStatus::ProviderAttestedFull
    );
    assert!(inspection.coverage.gaps.is_empty());
  }

  #[test]
  fn text_layer_alone_does_not_claim_visual_coverage() {
    let mut observation = complete_minimal_observation();
    observation.ocr = PdfOcrCoverage::NotRun;
    let inspection = inspect_pdf_with_observations(
      MINIMAL_PDF,
      observation_batch(MINIMAL_PDF, vec![observation]),
    )
    .unwrap();
    assert_eq!(
      inspection.coverage.gaps,
      vec![PdfInspectionGap::UnobservedVisualContent]
    );
  }

  #[test]
  fn observation_rejects_utf16_surrogate_splits_and_out_of_page_boxes() {
    let invalid = PdfPageObservation {
      page_index: 0,
      width_points: 612.0,
      height_points: 792.0,
      text: String::from("😀"),
      glyphs: vec![PdfGlyphObservation {
        start: 0,
        end: 1,
        bounds: PdfRect {
          left: 0.0,
          bottom: 0.0,
          right: 613.0,
          top: 10.0,
        },
        source: PdfGlyphSource::EmbeddedText,
      }],
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::NotRun,
      image_count: 0,
    };
    let error = inspect_pdf_with_observations(
      MINIMAL_PDF,
      observation_batch(MINIMAL_PDF, vec![invalid]),
    )
    .unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidObservation);
  }

  #[test]
  fn rejects_documents_above_the_input_limit_before_parsing() {
    let bytes = vec![0; PDF_DOCUMENT_MAX_BYTES + 1];
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::DocumentLimitExceeded);
  }

  #[test]
  fn rejects_glyph_counts_above_the_limit_without_allocating_them() {
    validate_glyph_count(PDF_MAX_GLYPHS).unwrap();
    assert_eq!(
      validate_glyph_count(PDF_MAX_GLYPHS.checked_add(1).unwrap())
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::ObservationLimitExceeded
    );
  }

  #[test]
  fn rejects_non_encrypted_documents_with_unloaded_xref_objects() {
    let mut document = Document::new();
    document.reference_table.entries.insert(
      1,
      XrefEntry::Normal {
        offset: 0,
        generation: 0,
      },
    );
    assert_eq!(
      validate_loaded_object_table(&document).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn encryption_marker_does_not_bypass_object_table_validation() {
    let mut document = Document::new();
    let encrypt = document.add_object(Dictionary::new());
    document.trailer.set("Encrypt", Object::Reference(encrypt));
    document.reference_table.entries.insert(
      99,
      XrefEntry::Normal {
        offset: 0,
        generation: 0,
      },
    );
    assert!(document.is_encrypted());
    assert_eq!(
      validate_loaded_object_table(&document).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn rejects_real_encrypted_documents_before_reporting_coverage() {
    assert_eq!(
      inspect_pdf(ENCRYPTED_PDF).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn parsed_encryption_marker_is_rejected_before_inspection() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let encrypt = document.add_object(Dictionary::new());
    document.trailer.set("Encrypt", Object::Reference(encrypt));
    assert!(document.is_encrypted());
    assert_eq!(
      inspect_parsed(MINIMAL_PDF, document, Vec::new(), None)
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn rejects_dangling_references_in_all_sensitive_object_locations() {
    for key in ["Contents", "Resources", "Metadata", "A"] {
      let mut document = Document::new();
      let mut dictionary = Dictionary::new();
      dictionary.set(key, Object::Reference((99, 0)));
      document
        .objects
        .insert((1, 0), Object::Dictionary(dictionary));
      assert_eq!(
        validate_all_indirect_references(&document)
          .unwrap_err()
          .code(),
        PdfInspectionErrorCode::InvalidDocument,
        "dangling {key} reference must fail"
      );
    }

    let mut encrypted = Document::new();
    encrypted.trailer.set("Encrypt", Object::Reference((99, 0)));
    assert_eq!(
      validate_all_indirect_references(&encrypted)
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn valid_indirect_reference_cycles_are_walked_safely() {
    let mut document = Document::new();
    document.objects.insert((1, 0), Object::Reference((2, 0)));
    document.objects.insert((2, 0), Object::Reference((1, 0)));
    validate_all_indirect_references(&document).unwrap();
  }

  #[test]
  fn rejects_dangling_page_content_before_reporting_coverage() {
    let mut bytes = MINIMAL_PDF.to_vec();
    let needle = b"/Contents 7 0 R";
    let offset = bytes
      .windows(needle.len())
      .position(|window| window == needle)
      .unwrap();
    let end = offset.checked_add(needle.len()).unwrap();
    bytes
      .get_mut(offset..end)
      .unwrap()
      .copy_from_slice(b"/Contents 9 0 R");
    assert_eq!(
      inspect_pdf(&bytes).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn observation_batches_are_exactly_document_bound_and_strict() {
    let mut wrong_document = observation_batch(MINIMAL_PDF, Vec::new());
    wrong_document.document.sha256 = "0".repeat(64);
    assert_eq!(
      inspect_pdf_with_observations(MINIMAL_PDF, wrong_document)
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::InvalidObservation
    );

    let mut unidentified = observation_batch(MINIMAL_PDF, Vec::new());
    unidentified.provider.version.clear();
    assert_eq!(
      inspect_pdf_with_observations(MINIMAL_PDF, unidentified)
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::InvalidObservation
    );

    let mut wrong_version = observation_batch(MINIMAL_PDF, Vec::new());
    wrong_version.version = PDF_OBSERVATION_BATCH_VERSION + 1;
    assert_eq!(
      inspect_pdf_with_observations(MINIMAL_PDF, wrong_version)
        .unwrap_err()
        .code(),
      PdfInspectionErrorCode::InvalidObservation
    );

    let unknown_field = serde_json::json!({
      "version": 1,
      "document": { "sha256": sha256_lower_hex(MINIMAL_PDF) },
      "provider": {
        "id": "test-renderer",
        "name": "Test Renderer",
        "version": "1.0.0"
      },
      "pages": [],
      "legacyObservations": []
    });
    assert!(
      serde_json::from_value::<PdfObservationBatch>(unknown_field).is_err()
    );
  }

  #[test]
  fn rejects_malformed_annotation_references() {
    let mut document = Document::new();
    let mut page = Dictionary::new();
    page.set("Annots", Object::Reference((99, 0)));
    let page_id = document.add_object(page);
    assert_eq!(
      annotation_count(&document, page_id).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  #[allow(clippy::float_cmp)]
  fn page_geometry_uses_the_inherited_rotated_crop_box() {
    let mut document = Document::new();
    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference((2, 0)));
    let mut page_tree = Dictionary::new();
    page_tree.set("Type", "Pages");
    page_tree.set("Kids", vec![Object::Reference((3, 0))]);
    page_tree.set("Count", 1);
    page_tree.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
    let mut page = Dictionary::new();
    page.set("Type", "Page");
    page.set("Parent", Object::Reference((2, 0)));
    page.set(
      "CropBox",
      vec![10.into(), 20.into(), 210.into(), 120.into()],
    );
    page.set("Rotate", 90);
    document.objects.insert((1, 0), Object::Dictionary(catalog));
    document
      .objects
      .insert((2, 0), Object::Dictionary(page_tree));
    document.objects.insert((3, 0), Object::Dictionary(page));
    document.trailer.set("Root", Object::Reference((1, 0)));
    let pages = validated_pages(&document).unwrap();
    assert_eq!(pages.len(), 1);
    let geometry = pages.first().unwrap();
    assert_eq!(geometry.width, 100.0);
    assert_eq!(geometry.height, 200.0);
  }

  #[test]
  fn inventories_structures_that_can_retain_sensitive_content() {
    let inspection = inspect_pdf(RISKY_PDF).unwrap();
    assert!(inspection.risks.acro_form_field_count >= 1);
    assert!(inspection.risks.annotation_count >= 2);
    assert!(inspection.risks.embedded_file_count >= 1);
    assert!(inspection.risks.document_info_entry_count >= 3);
    assert!(inspection.risks.external_action_count >= 1);
    assert!(inspection.risks.image_object_count >= 1);
    assert!(inspection.risks.javascript_action_count >= 1);
    assert!(inspection.risks.metadata_stream_count >= 1);
    assert!(inspection.risks.optional_content_group_count >= 1);
    assert!(inspection.risks.signature_count >= 1);
    assert!(inspection.risks.xfa_entry_count >= 1);
  }

  #[test]
  fn rejects_missing_page_tree_instead_of_claiming_full_coverage() {
    let mut bytes = MINIMAL_PDF.to_vec();
    let needle = b"/Pages 6 0 R";
    let offset = bytes
      .windows(needle.len())
      .position(|window| window == needle)
      .unwrap();
    let end = offset.checked_add(needle.len()).unwrap();
    bytes
      .get_mut(offset..end)
      .unwrap()
      .copy_from_slice(b"/Pages 9 0 R");
    assert_eq!(
      inspect_pdf(&bytes).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn rejects_object_stream_capable_pdf_versions() {
    let mut bytes = MINIMAL_PDF.to_vec();
    *bytes.get_mut(7).unwrap() = b'5';
    assert_eq!(
      inspect_pdf(&bytes).unwrap_err().code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn full_observations_require_geometry_and_non_whitespace_glyph_coverage() {
    let observation = PdfPageObservation {
      page_index: 0,
      width_points: 612.0,
      height_points: 792.0,
      text: String::from("😀 A"),
      glyphs: vec![PdfGlyphObservation {
        start: 0,
        end: 2,
        bounds: PdfRect {
          left: 10.0,
          bottom: 10.0,
          right: 20.0,
          top: 20.0,
        },
        source: PdfGlyphSource::EmbeddedText,
      }],
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    };
    assert_eq!(
      inspect_pdf_with_observations(
        MINIMAL_PDF,
        observation_batch(MINIMAL_PDF, vec![observation]),
      )
      .unwrap_err()
      .code(),
      PdfInspectionErrorCode::InvalidObservation
    );
    let wrong_geometry = PdfPageObservation {
      page_index: 0,
      width_points: 100.0,
      height_points: 100.0,
      text: String::new(),
      glyphs: Vec::new(),
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    };
    assert_eq!(
      inspect_pdf_with_observations(
        MINIMAL_PDF,
        observation_batch(MINIMAL_PDF, vec![wrong_geometry]),
      )
      .unwrap_err()
      .code(),
      PdfInspectionErrorCode::InvalidObservation
    );
  }

  #[test]
  fn retained_trailing_bytes_are_an_explicit_coverage_gap() {
    let mut bytes = MINIMAL_PDF.to_vec();
    bytes.extend_from_slice(b"\nSENSITIVE-TRAILING-BYTES\n");
    let inspection = inspect_pdf(&bytes).unwrap();
    assert!(inspection.risks.trailing_data_byte_count > 0);
    assert!(
      inspection
        .coverage
        .gaps
        .contains(&PdfInspectionGap::RetainedDocumentBytes)
    );
  }
}
