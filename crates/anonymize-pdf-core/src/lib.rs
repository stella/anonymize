#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::fmt;

use lopdf::xref::XrefEntry;
use lopdf::{Dictionary, Document, LoadOptions, Object};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod raster;

pub use raster::{
  PDF_RASTER_CONTRACT_VERSION, PDF_RASTER_MAX_DETECTIONS,
  PDF_RASTER_MAX_GLYPHS, PDF_RASTER_MAX_OUTPUT_BYTES,
  PDF_RASTER_MAX_PAGE_BYTES, PDF_RASTER_MAX_TOTAL_BYTES,
  PDF_RASTER_REQUEST_JSON_MAX_BYTES, PdfRasterDetection, PdfRasterError,
  PdfRasterErrorCode, PdfRasterPage, PdfRasterProvider, PdfRasterRewrite,
  PdfRasterRewriteCertificate, rewrite_pdf_raster_from_detections,
};

pub const PDF_INSPECTION_CONTRACT_VERSION: u8 = 1;
pub const PDF_DOCUMENT_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_STREAM_DECOMPRESSED_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PDF_LOADED_PAYLOAD_MAX_BYTES: usize = 128 * 1024 * 1024;
pub const PDF_MAX_OBJECTS: usize = 200_000;
pub const PDF_MAX_OBJECT_NODES: usize = 1_000_000;
pub const PDF_MAX_OBJECT_DEPTH: usize = 128;
pub const PDF_MAX_PAGES: usize = 10_000;
pub const PDF_MAX_GLYPHS: usize = 5_000_000;
pub const PDF_MAX_PAGE_TEXT_UTF8_BYTES: usize = 16 * 1024 * 1024;
pub const PDF_MAX_OBSERVED_TEXT_UTF8_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_OBSERVATIONS_JSON_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const PDF_PAGE_DIMENSION_TOLERANCE_POINTS: f64 = 0.25;

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
  /// Bounds in the normalized displayed-page coordinate space: PDF points,
  /// origin at the effective visible page's bottom-left, with page rotation,
  /// `CropBox` translation, and `UserUnit` scaling already applied.
  pub bounds: PdfRect,
  pub source: PdfGlyphSource,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPageObservation {
  /// Zero-based page index.
  pub page_index: u32,
  /// Effective displayed width after CropBox/MediaBox intersection, rotation,
  /// and `UserUnit` scaling.
  pub width_points: f64,
  /// Effective displayed height after CropBox/MediaBox intersection, rotation,
  /// and `UserUnit` scaling.
  pub height_points: f64,
  pub text: String,
  pub glyphs: Vec<PdfGlyphObservation>,
  pub rendered: bool,
  pub text_layer: PdfTextLayerCoverage,
  pub ocr: PdfOcrCoverage,
  pub image_count: u32,
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
  /// Reusable Form `XObject` streams can retain text, images, and nested content.
  pub form_x_object_count: u32,
  pub image_object_count: u32,
  /// Additional completed `startxref`/`%%EOF` revision markers retained in the
  /// source bytes. Superseded revision contents are not claimed as inspected.
  pub incremental_revision_count: u32,
  pub javascript_action_count: u32,
  pub metadata_stream_count: u32,
  pub optional_content_group_count: u32,
  pub signature_count: u32,
  /// Non-whitespace bytes retained after the final `%%EOF` marker.
  pub trailing_non_whitespace_byte_count: u64,
  /// Action dictionaries whose `/S` kind is not defined by the supported PDF
  /// action vocabulary. They remain an explicit risk instead of being ignored.
  pub unsupported_action_count: u32,
  pub xfa_entry_count: u32,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfInspectionGap {
  EncryptedDocument,
  PageContentNotObserved,
  PageNotRendered,
  PartialTextLayer,
  /// Incremental revisions or non-whitespace trailing bytes remain in the
  /// source document and may retain content outside the current object graph.
  RetainedDocumentBytes,
  /// Rendered page pixels were not completely covered by OCR. This includes
  /// images, vector outlines, and any other visible content outside the text
  /// layer.
  UnobservedVisualContent,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfInspectionCoverageStatus {
  Full,
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
  inspect_pdf_with_observations(document, Vec::new())
}

pub fn validate_pdf_observations_json_byte_length(
  byte_length: usize,
) -> Result<(), PdfInspectionError> {
  if byte_length <= PDF_OBSERVATIONS_JSON_MAX_BYTES {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::ObservationLimitExceeded,
    format!(
      "PDF observations JSON must not exceed {PDF_OBSERVATIONS_JSON_MAX_BYTES} bytes"
    ),
  ))
}

pub fn inspect_pdf_with_provider<P: PdfPageObservationProvider>(
  document: &[u8],
  provider: &mut P,
) -> Result<PdfInspection, PdfInspectionError> {
  let parsed = parse_document(document)?;
  let pages = validated_pages(&parsed)?;
  let mut observations = Vec::with_capacity(pages.len());
  for page_index in 0..pages.len() {
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
  inspect_parsed(document, parsed, &pages, observations)
}

pub fn inspect_pdf_with_observations(
  document: &[u8],
  observations: Vec<PdfPageObservation>,
) -> Result<PdfInspection, PdfInspectionError> {
  let parsed = parse_document(document)?;
  let pages = validated_pages(&parsed)?;
  inspect_parsed(document, parsed, &pages, observations)
}

fn parse_document(document: &[u8]) -> Result<Document, PdfInspectionError> {
  if document.len() > PDF_DOCUMENT_MAX_BYTES {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!("PDF documents must not exceed {PDF_DOCUMENT_MAX_BYTES} bytes"),
    ));
  }
  let parsed = Document::load_mem_with_options(
    document,
    LoadOptions {
      strict: true,
      max_decompressed_size: Some(PDF_STREAM_DECOMPRESSED_MAX_BYTES),
      ..LoadOptions::default()
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
  if parsed.objects.len() > PDF_MAX_OBJECTS {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF documents must not contain more than {PDF_MAX_OBJECTS} objects"
      ),
    ));
  }
  validate_loaded_payload(&parsed, PDF_LOADED_PAYLOAD_MAX_BYTES)?;
  validate_references(&parsed)?;
  Ok(parsed)
}

fn validate_loaded_object_table(
  document: &Document,
) -> Result<(), PdfInspectionError> {
  if document.is_encrypted() {
    return Ok(());
  }
  let fully_loaded =
    document
      .reference_table
      .entries
      .iter()
      .all(|(object_number, entry)| match entry {
        XrefEntry::Free | XrefEntry::UnusableFree => true,
        XrefEntry::Normal { generation, .. } => document
          .objects
          .contains_key(&(*object_number, *generation)),
        XrefEntry::Compressed { .. } => {
          document.objects.contains_key(&(*object_number, 0))
        }
      });
  if fully_loaded {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::InvalidDocument,
    "PDF object table could not be fully loaded within parser limits",
  ))
}

fn validate_loaded_payload(
  document: &Document,
  limit: usize,
) -> Result<(), PdfInspectionError> {
  let mut loaded_bytes = 0usize;
  for object in document.objects.values() {
    account_loaded_payload(object, 0, &mut loaded_bytes, limit)?;
  }
  account_dictionary_payload(&document.trailer, 0, &mut loaded_bytes, limit)
}

fn account_loaded_payload(
  object: &Object,
  depth: usize,
  loaded_bytes: &mut usize,
  limit: usize,
) -> Result<(), PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF objects must not be nested deeper than {PDF_MAX_OBJECT_DEPTH} levels"
      ),
    ));
  }
  match object {
    Object::String(bytes, _) | Object::Name(bytes) => {
      add_loaded_payload(bytes.len(), loaded_bytes, limit)?;
    }
    Object::Array(values) => {
      for value in values {
        account_loaded_payload(
          value,
          depth.saturating_add(1),
          loaded_bytes,
          limit,
        )?;
      }
    }
    Object::Dictionary(dictionary) => {
      account_dictionary_payload(dictionary, depth, loaded_bytes, limit)?;
    }
    Object::Stream(stream) => {
      add_loaded_payload(stream.content.len(), loaded_bytes, limit)?;
      account_dictionary_payload(&stream.dict, depth, loaded_bytes, limit)?;
    }
    _ => {}
  }
  Ok(())
}

fn account_dictionary_payload(
  dictionary: &Dictionary,
  depth: usize,
  loaded_bytes: &mut usize,
  limit: usize,
) -> Result<(), PdfInspectionError> {
  for (key, value) in dictionary {
    add_loaded_payload(key.len(), loaded_bytes, limit)?;
    account_loaded_payload(
      value,
      depth.saturating_add(1),
      loaded_bytes,
      limit,
    )?;
  }
  Ok(())
}

fn add_loaded_payload(
  additional: usize,
  loaded_bytes: &mut usize,
  limit: usize,
) -> Result<(), PdfInspectionError> {
  *loaded_bytes = loaded_bytes.checked_add(additional).ok_or_else(|| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF loaded payload byte count overflowed",
    )
  })?;
  if *loaded_bytes <= limit {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::DocumentLimitExceeded,
    format!("PDF loaded object payload must not exceed {limit} bytes"),
  ))
}

fn validate_references(document: &Document) -> Result<(), PdfInspectionError> {
  for object in document.objects.values() {
    validate_object_references(object, document, 0)?;
  }
  validate_dictionary_references(&document.trailer, document, 0)
}

fn validate_object_references(
  object: &Object,
  document: &Document,
  depth: usize,
) -> Result<(), PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      format!(
        "PDF objects must not be nested deeper than {PDF_MAX_OBJECT_DEPTH} levels"
      ),
    ));
  }
  match object {
    Object::Reference(id) => {
      document.get_object(*id).map_err(|_| {
        invalid_document(
          "PDF indirect references must resolve to loaded objects",
        )
      })?;
    }
    Object::Array(values) => {
      for value in values {
        validate_object_references(value, document, depth.saturating_add(1))?;
      }
    }
    Object::Dictionary(dictionary) => {
      validate_dictionary_references(dictionary, document, depth)?;
    }
    Object::Stream(stream) => {
      validate_dictionary_references(&stream.dict, document, depth)?;
    }
    _ => {}
  }
  Ok(())
}

fn validate_dictionary_references(
  dictionary: &Dictionary,
  document: &Document,
  depth: usize,
) -> Result<(), PdfInspectionError> {
  for (_, value) in dictionary {
    validate_object_references(value, document, depth.saturating_add(1))?;
  }
  Ok(())
}

#[derive(Debug, Clone, Copy)]
struct ValidatedPage {
  id: lopdf::ObjectId,
  width_points: f64,
  height_points: f64,
}

#[derive(Debug, Clone, Copy)]
struct RawRetentionInventory {
  incremental_revision_count: u32,
  trailing_non_whitespace_byte_count: u64,
}

fn raw_retention_inventory(
  bytes: &[u8],
  active_xref_start: usize,
) -> Result<RawRetentionInventory, PdfInspectionError> {
  const EOF_MARKER: &[u8] = b"%%EOF";
  const STARTXREF_MARKER: &[u8] = b"startxref";
  let completed_revisions = bytes
    .windows(STARTXREF_MARKER.len())
    .enumerate()
    .filter_map(|(position, window)| {
      if window != STARTXREF_MARKER {
        return None;
      }
      let mut cursor = position.checked_add(STARTXREF_MARKER.len())?;
      while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor = cursor.checked_add(1)?;
      }
      let offset_start = cursor;
      let mut xref_start = 0usize;
      while let Some(digit) = bytes.get(cursor).and_then(|byte| {
        byte
          .is_ascii_digit()
          .then(|| byte.checked_sub(b'0').map(usize::from))
          .flatten()
      }) {
        xref_start = xref_start.checked_mul(10)?.checked_add(digit)?;
        cursor = cursor.checked_add(1)?;
      }
      if cursor == offset_start {
        return None;
      }
      while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor = cursor.checked_add(1)?;
      }
      bytes
        .get(cursor..)
        .is_some_and(|tail| tail.starts_with(EOF_MARKER))
        .then_some((xref_start, cursor))
    })
    .collect::<Vec<_>>();
  // Use the first syntactically completed revision that points at the xref
  // table actually selected by the parser. A later marker in appended bytes,
  // even one repeating the valid xref offset, can therefore never move the
  // retention boundary past hidden data.
  let final_eof_start = completed_revisions
    .iter()
    .find_map(|(xref_start, eof_start)| {
      (*xref_start == active_xref_start).then_some(*eof_start)
    })
    .ok_or_else(|| {
      invalid_document(
        "PDF active revision must end with a matching startxref and %%EOF",
      )
    })?;
  let completed_revision_count = completed_revisions.len();
  let incremental_revision_count = u32::try_from(
    completed_revision_count.saturating_sub(1),
  )
  .map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF incremental revision count overflowed",
    )
  })?;
  let trailing_start = final_eof_start
    .checked_add(EOF_MARKER.len())
    .ok_or_else(|| invalid_document("PDF final EOF offset overflowed"))?;
  let trailing_non_whitespace_byte_count = u64::try_from(
    bytes
      .get(trailing_start..)
      .ok_or_else(|| invalid_document("PDF final EOF offset is invalid"))?
      .iter()
      .filter(|byte| !byte.is_ascii_whitespace())
      .count(),
  )
  .map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF trailing byte count overflowed",
    )
  })?;
  Ok(RawRetentionInventory {
    incremental_revision_count,
    trailing_non_whitespace_byte_count,
  })
}

#[derive(Debug, Clone, Copy, Default)]
struct InheritedPageGeometry {
  media_box: Option<[f64; 4]>,
  crop_box: Option<[f64; 4]>,
  rotate: i64,
}

struct PageTreeValidator<'a> {
  document: &'a Document,
  visited: BTreeSet<lopdf::ObjectId>,
  pages: Vec<ValidatedPage>,
  node_count: usize,
}

fn invalid_document(message: impl Into<String>) -> PdfInspectionError {
  error(PdfInspectionErrorCode::InvalidDocument, message)
}

fn validated_pages(
  document: &Document,
) -> Result<Vec<ValidatedPage>, PdfInspectionError> {
  let catalog = document
    .catalog()
    .map_err(|_| invalid_document("PDF catalog must be a valid dictionary"))?;
  if !name_deref_is(catalog, b"Type", b"Catalog", document) {
    return Err(invalid_document("PDF catalog must have type Catalog"));
  }
  let pages_id = catalog
    .get(b"Pages")
    .and_then(Object::as_reference)
    .map_err(|_| {
      invalid_document("PDF catalog Pages must be an indirect reference")
    })?;
  let mut validator = PageTreeValidator {
    document,
    visited: BTreeSet::new(),
    pages: Vec::new(),
    node_count: 0,
  };
  let initial_geometry = InheritedPageGeometry::default();
  let page_count =
    validator.walk_pages_node(pages_id, None, &initial_geometry, 0)?;
  if page_count != validator.pages.len() {
    return Err(invalid_document("PDF page tree count is inconsistent"));
  }
  Ok(validator.pages)
}

impl PageTreeValidator<'_> {
  fn walk_pages_node(
    &mut self,
    node_id: lopdf::ObjectId,
    expected_parent: Option<lopdf::ObjectId>,
    inherited: &InheritedPageGeometry,
    depth: usize,
  ) -> Result<usize, PdfInspectionError> {
    if depth > PDF_MAX_OBJECT_DEPTH {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        format!("PDF page trees must not exceed {PDF_MAX_OBJECT_DEPTH} levels"),
      ));
    }
    self.node_count = self.node_count.checked_add(1).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF page-tree node count overflowed",
      )
    })?;
    if self.node_count > PDF_MAX_OBJECT_NODES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        format!(
          "PDF page trees must not contain more than {PDF_MAX_OBJECT_NODES} nodes"
        ),
      ));
    }
    if !self.visited.insert(node_id) {
      return Err(invalid_document(
        "PDF page tree must not contain cycles or duplicate nodes",
      ));
    }
    let node = self.document.get_dictionary(node_id).map_err(|_| {
      invalid_document("PDF page-tree references must resolve to dictionaries")
    })?;
    validate_parent(node, expected_parent)?;
    let geometry = inherited_geometry(node, self.document, inherited)?;
    let node_type = node
      .get_deref(b"Type", self.document)
      .and_then(Object::as_name)
      .map_err(|_| {
        invalid_document("PDF page-tree nodes must declare a valid Type")
      })?;
    match node_type {
      b"Pages" => self.walk_pages_container(node_id, node, &geometry, depth),
      b"Page" => {
        if expected_parent.is_none() {
          return Err(invalid_document(
            "PDF page-tree root must have type Pages",
          ));
        }
        if node.get(b"Kids").is_ok() || node.get(b"Count").is_ok() {
          return Err(invalid_document(
            "PDF Page nodes must not contain page-tree Kids or Count entries",
          ));
        }
        let page = effective_page(node_id, node, self.document, &geometry)?;
        if self.pages.len() >= PDF_MAX_PAGES {
          return Err(error(
            PdfInspectionErrorCode::DocumentLimitExceeded,
            format!(
              "PDF documents must not contain more than {PDF_MAX_PAGES} pages"
            ),
          ));
        }
        self.pages.push(page);
        Ok(1)
      }
      _ => Err(invalid_document(
        "PDF page-tree nodes must have type Pages or Page",
      )),
    }
  }

  fn walk_pages_container(
    &mut self,
    node_id: lopdf::ObjectId,
    node: &Dictionary,
    inherited: &InheritedPageGeometry,
    depth: usize,
  ) -> Result<usize, PdfInspectionError> {
    let declared_count = node
      .get_deref(b"Count", self.document)
      .and_then(Object::as_i64)
      .map_err(|_| invalid_document("PDF Pages Count must be an integer"))?;
    let declared_count = usize::try_from(declared_count).map_err(|_| {
      invalid_document("PDF Pages Count must be non-negative and bounded")
    })?;
    if declared_count > PDF_MAX_PAGES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        format!(
          "PDF documents must not contain more than {PDF_MAX_PAGES} pages"
        ),
      ));
    }
    let kids = node
      .get_deref(b"Kids", self.document)
      .and_then(Object::as_array)
      .map_err(|_| {
        invalid_document("PDF Pages Kids must resolve to an array")
      })?;
    let mut actual_count = 0usize;
    for kid in kids {
      let kid_id = kid.as_reference().map_err(|_| {
        invalid_document("PDF Pages Kids entries must be indirect references")
      })?;
      actual_count = actual_count
        .checked_add(self.walk_pages_node(
          kid_id,
          Some(node_id),
          inherited,
          depth.saturating_add(1),
        )?)
        .ok_or_else(|| {
          error(
            PdfInspectionErrorCode::DocumentLimitExceeded,
            "PDF page count overflowed",
          )
        })?;
    }
    if actual_count != declared_count {
      return Err(invalid_document(
        "PDF Pages Count must equal the number of descendant pages",
      ));
    }
    Ok(actual_count)
  }
}

fn validate_parent(
  node: &Dictionary,
  expected_parent: Option<lopdf::ObjectId>,
) -> Result<(), PdfInspectionError> {
  match expected_parent {
    Some(expected) => {
      let actual =
        node
          .get(b"Parent")
          .and_then(Object::as_reference)
          .map_err(|_| {
            invalid_document(
              "PDF non-root page-tree nodes must reference Parent",
            )
          })?;
      if actual != expected {
        return Err(invalid_document(
          "PDF page-tree Parent reference is inconsistent",
        ));
      }
    }
    None if node.get(b"Parent").is_ok() => {
      return Err(invalid_document(
        "PDF page-tree root must not contain a Parent entry",
      ));
    }
    None => {}
  }
  Ok(())
}

fn inherited_geometry(
  node: &Dictionary,
  document: &Document,
  inherited: &InheritedPageGeometry,
) -> Result<InheritedPageGeometry, PdfInspectionError> {
  let media_box =
    optional_box(node, b"MediaBox", document)?.or(inherited.media_box);
  let crop_box =
    optional_box(node, b"CropBox", document)?.or(inherited.crop_box);
  let rotate = match node.get_deref(b"Rotate", document) {
    Ok(value) => value
      .as_i64()
      .map_err(|_| invalid_document("PDF page Rotate must be an integer"))?,
    Err(lopdf::Error::DictKey(_)) => inherited.rotate,
    Err(_) => return Err(invalid_document("PDF page Rotate must resolve")),
  };
  if rotate.rem_euclid(90) != 0 {
    return Err(invalid_document(
      "PDF page Rotate must be a multiple of 90 degrees",
    ));
  }
  Ok(InheritedPageGeometry {
    media_box,
    crop_box,
    rotate: rotate.rem_euclid(360),
  })
}

fn optional_box(
  dictionary: &Dictionary,
  key: &[u8],
  document: &Document,
) -> Result<Option<[f64; 4]>, PdfInspectionError> {
  let box_object = match dictionary.get_deref(key, document) {
    Ok(box_object) => box_object,
    Err(lopdf::Error::DictKey(_)) => return Ok(None),
    Err(_) => return Err(invalid_document("PDF page box must resolve")),
  };
  let values = box_object
    .as_array()
    .map_err(|_| invalid_document("PDF page box must be an array"))?;
  if values.len() != 4 {
    return Err(invalid_document(
      "PDF page box must contain exactly four numbers",
    ));
  }
  let mut result = [0.0; 4];
  for (target, coordinate) in result.iter_mut().zip(values) {
    *target = pdf_number(coordinate)?;
  }
  if result.iter().any(|coordinate| !coordinate.is_finite())
    || result[0] >= result[2]
    || result[1] >= result[3]
  {
    return Err(invalid_document(
      "PDF page box must be finite and non-empty",
    ));
  }
  Ok(Some(result))
}

fn pdf_number(value: &Object) -> Result<f64, PdfInspectionError> {
  match value {
    Object::Integer(value) => value.to_string().parse::<f64>().map_err(|_| {
      invalid_document("PDF page box integer coordinate is out of range")
    }),
    Object::Real(value) => Ok(f64::from(*value)),
    _ => Err(invalid_document("PDF page box coordinates must be numbers")),
  }
}

fn effective_page(
  id: lopdf::ObjectId,
  page: &Dictionary,
  document: &Document,
  geometry: &InheritedPageGeometry,
) -> Result<ValidatedPage, PdfInspectionError> {
  let media_box = geometry
    .media_box
    .ok_or_else(|| invalid_document("PDF pages must inherit a MediaBox"))?;
  let crop_box = geometry.crop_box.unwrap_or(media_box);
  let visible_box = [
    crop_box[0].max(media_box[0]),
    crop_box[1].max(media_box[1]),
    crop_box[2].min(media_box[2]),
    crop_box[3].min(media_box[3]),
  ];
  if visible_box[0] >= visible_box[2] || visible_box[1] >= visible_box[3] {
    return Err(invalid_document(
      "PDF effective CropBox and MediaBox intersection must be non-empty",
    ));
  }
  let user_unit = match page.get_deref(b"UserUnit", document) {
    Ok(value) => pdf_number(value)?,
    Err(lopdf::Error::DictKey(_)) => 1.0,
    Err(_) => return Err(invalid_document("PDF page UserUnit must resolve")),
  };
  if !user_unit.is_finite() || user_unit <= 0.0 {
    return Err(invalid_document(
      "PDF page UserUnit must be finite and positive",
    ));
  }
  let width = (visible_box[2] - visible_box[0]) * user_unit;
  let height = (visible_box[3] - visible_box[1]) * user_unit;
  let (width_points, height_points) =
    if geometry.rotate == 90 || geometry.rotate == 270 {
      (height, width)
    } else {
      (width, height)
    };
  Ok(ValidatedPage {
    id,
    width_points,
    height_points,
  })
}

fn inspect_parsed(
  bytes: &[u8],
  document: Document,
  pages: &[ValidatedPage],
  observations: Vec<PdfPageObservation>,
) -> Result<PdfInspection, PdfInspectionError> {
  if observations.len() > pages.len() {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      "PDF page observations exceed the document page count",
    ));
  }
  let observations = validate_observations(observations, pages)?;
  let retention = raw_retention_inventory(bytes, document.xref_start)?;
  let risks = risk_inventory(&document, pages, retention)?;
  let mut page_inspections = Vec::with_capacity(pages.len());
  for (page_offset, page) in pages.iter().enumerate() {
    let page_index = u32::try_from(page_offset).map_err(|_| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF page index overflowed",
      )
    })?;
    let annotation_count = document
      .get_dictionary(page.id)
      .map_err(|_| invalid_document("PDF page dictionary became unavailable"))
      .and_then(|page| annotation_count(page, &document))?;
    page_inspections.push(PdfPageInspection {
      page_index,
      annotation_count,
      observation: observations
        .iter()
        .find(|observation| observation.page_index == page_index)
        .cloned(),
    });
  }
  let encrypted = document.is_encrypted();
  let coverage = coverage(encrypted, &page_inspections, retention);
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
  let mut observed_text_bytes = 0usize;
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
    let page = pages.get(page_index).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observation page does not exist",
      )
    })?;
    observed_text_bytes = observed_text_bytes
      .checked_add(observation.text.len())
      .ok_or_else(|| {
        error(
          PdfInspectionErrorCode::ObservationLimitExceeded,
          "PDF observed text byte count overflowed",
        )
      })?;
    if observed_text_bytes > PDF_MAX_OBSERVED_TEXT_UTF8_BYTES {
      return Err(error(
        PdfInspectionErrorCode::ObservationLimitExceeded,
        format!(
          "PDF observations must not contain more than {PDF_MAX_OBSERVED_TEXT_UTF8_BYTES} UTF-8 text bytes"
        ),
      ));
    }
    validate_observation(observation, page)?;
    glyph_count = glyph_count
      .checked_add(observation.glyphs.len())
      .ok_or_else(|| {
        error(
          PdfInspectionErrorCode::ObservationLimitExceeded,
          "PDF glyph observation count overflowed",
        )
      })?;
    if glyph_count > PDF_MAX_GLYPHS {
      return Err(error(
        PdfInspectionErrorCode::ObservationLimitExceeded,
        format!(
          "PDF observations must not contain more than {PDF_MAX_GLYPHS} glyphs"
        ),
      ));
    }
  }
  Ok(observations)
}

fn validate_observation(
  observation: &PdfPageObservation,
  page: &ValidatedPage,
) -> Result<(), PdfInspectionError> {
  if observation.text.len() > PDF_MAX_PAGE_TEXT_UTF8_BYTES {
    return Err(error(
      PdfInspectionErrorCode::ObservationLimitExceeded,
      format!(
        "PDF observed page text must not exceed {PDF_MAX_PAGE_TEXT_UTF8_BYTES} UTF-8 bytes"
      ),
    ));
  }
  validate_dimension(observation.width_points, "width")?;
  validate_dimension(observation.height_points, "height")?;
  validate_page_dimensions(observation, page)?;
  let utf16_boundaries = utf16_boundaries(&observation.text)?;
  let mut previous_end = 0;
  for glyph in &observation.glyphs {
    if glyph.start >= glyph.end || glyph.start < previous_end {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF glyph spans must be non-empty, ordered, and non-overlapping",
      ));
    }
    if !is_utf16_boundary(&utf16_boundaries, glyph.start)
      || !is_utf16_boundary(&utf16_boundaries, glyph.end)
    {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF glyph spans must use valid UTF-16 code-unit boundaries",
      ));
    }
    validate_rect(&glyph.bounds, observation)?;
    if glyph.source == PdfGlyphSource::EmbeddedText
      && observation.text_layer == PdfTextLayerCoverage::Absent
    {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF embedded-text glyphs require an observed text layer",
      ));
    }
    if glyph.source == PdfGlyphSource::Ocr
      && observation.ocr == PdfOcrCoverage::NotRun
    {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF OCR glyphs require OCR to have run",
      ));
    }
    previous_end = glyph.end;
  }
  if observation.text_layer == PdfTextLayerCoverage::Complete {
    let text_end = u32::try_from(utf16_boundaries.len().saturating_sub(1))
      .map_err(|_| {
        error(
          PdfInspectionErrorCode::InvalidObservation,
          "PDF observed text offset overflowed",
        )
      })?;
    let exactly_covered = observation
      .glyphs
      .iter()
      .try_fold(0u32, |expected_start, glyph| {
        (glyph.start == expected_start
          && glyph.source == PdfGlyphSource::EmbeddedText)
          .then_some(glyph.end)
      })
      .is_some_and(|end| end == text_end);
    if !exactly_covered {
      return Err(error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF complete text layers require embedded-text glyph spans to cover all observed text exactly",
      ));
    }
  }
  if !observation.rendered && observation.ocr != PdfOcrCoverage::NotRun {
    return Err(error(
      PdfInspectionErrorCode::InvalidObservation,
      "PDF OCR coverage requires a rendered page",
    ));
  }
  Ok(())
}

fn validate_page_dimensions(
  observation: &PdfPageObservation,
  page: &ValidatedPage,
) -> Result<(), PdfInspectionError> {
  let width_delta = (observation.width_points - page.width_points).abs();
  let height_delta = (observation.height_points - page.height_points).abs();
  if width_delta <= PDF_PAGE_DIMENSION_TOLERANCE_POINTS
    && height_delta <= PDF_PAGE_DIMENSION_TOLERANCE_POINTS
  {
    return Ok(());
  }
  Err(error(
    PdfInspectionErrorCode::InvalidObservation,
    format!(
      "PDF observed page dimensions must match effective page geometry within {PDF_PAGE_DIMENSION_TOLERANCE_POINTS} points"
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

fn utf16_boundaries(text: &str) -> Result<Vec<bool>, PdfInspectionError> {
  let code_unit_count = text.encode_utf16().count();
  let mut result = vec![false; code_unit_count.saturating_add(1)];
  if let Some(start) = result.first_mut() {
    *start = true;
  }
  let mut offset = 0u32;
  for character in text.chars() {
    offset = offset
      .checked_add(u32::try_from(character.len_utf16()).map_err(|_| {
        error(
          PdfInspectionErrorCode::InvalidObservation,
          "PDF observed text offset overflowed",
        )
      })?)
      .ok_or_else(|| {
        error(
          PdfInspectionErrorCode::InvalidObservation,
          "PDF observed text offset overflowed",
        )
      })?;
    let boundary = usize::try_from(offset).map_err(|_| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observed text offset overflowed",
      )
    })?;
    let target = result.get_mut(boundary).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::InvalidObservation,
        "PDF observed text offset exceeded its UTF-16 length",
      )
    })?;
    *target = true;
  }
  Ok(result)
}

fn is_utf16_boundary(boundaries: &[bool], offset: u32) -> bool {
  usize::try_from(offset)
    .ok()
    .and_then(|index| boundaries.get(index))
    .copied()
    .unwrap_or(false)
}

fn coverage(
  encrypted: bool,
  pages: &[PdfPageInspection],
  retention: RawRetentionInventory,
) -> PdfInspectionCoverage {
  let mut gaps = BTreeSet::new();
  if encrypted {
    gaps.insert(PdfInspectionGap::EncryptedDocument);
  }
  if retention.incremental_revision_count > 0
    || retention.trailing_non_whitespace_byte_count > 0
  {
    gaps.insert(PdfInspectionGap::RetainedDocumentBytes);
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
      PdfInspectionCoverageStatus::Full
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
    PdfInspectionGap::PageContentNotObserved => 1,
    PdfInspectionGap::PageNotRendered => 2,
    PdfInspectionGap::PartialTextLayer => 3,
    PdfInspectionGap::RetainedDocumentBytes => 4,
    PdfInspectionGap::UnobservedVisualContent => 5,
  }
}

fn risk_inventory(
  document: &Document,
  pages: &[ValidatedPage],
  retention: RawRetentionInventory,
) -> Result<PdfRiskInventory, PdfInspectionError> {
  let mut inventory = PdfRiskInventory {
    acro_form_field_count: 0,
    annotation_count: 0,
    document_info_entry_count: info_entry_count(document)?,
    embedded_file_count: 0,
    external_action_count: 0,
    form_x_object_count: 0,
    image_object_count: 0,
    incremental_revision_count: retention.incremental_revision_count,
    javascript_action_count: 0,
    metadata_stream_count: 0,
    optional_content_group_count: 0,
    signature_count: 0,
    trailing_non_whitespace_byte_count: retention
      .trailing_non_whitespace_byte_count,
    unsupported_action_count: 0,
    xfa_entry_count: catalog_xfa_count(document)?,
  };
  let mut structure_risks = validate_risk_structures(document, pages)?;
  let mut scanned_nodes = 0usize;
  for (object_id, object) in &document.objects {
    scan_risk_object(
      object,
      Some(*object_id),
      document,
      &mut inventory,
      &mut structure_risks,
      0,
      &mut scanned_nodes,
    )?;
  }
  inventory.external_action_count = structure_risks.actions.external;
  inventory.javascript_action_count = structure_risks.actions.javascript;
  inventory.unsupported_action_count = structure_risks.actions.unsupported;
  structure_risks.attachments.add_typed_streams(document);
  inventory.embedded_file_count = structure_risks.attachments.count();
  for page in pages {
    let page_dictionary = document.get_dictionary(page.id).map_err(|_| {
      invalid_document("PDF page dictionary became unavailable")
    })?;
    let count = annotation_count(page_dictionary, document)?;
    inventory.annotation_count =
      inventory.annotation_count.saturating_add(count);
  }
  Ok(inventory)
}

fn scan_risk_object(
  object: &Object,
  object_id: Option<lopdf::ObjectId>,
  document: &Document,
  inventory: &mut PdfRiskInventory,
  structure_risks: &mut StructuralRiskInventory,
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
    inventory_retained_action_object(
      object,
      object_id,
      dictionary,
      document,
      structure_risks,
    )?;
    if name_deref_is(dictionary, b"Type", b"Filespec", document)
      || dictionary.get(b"EF").is_ok()
      || dictionary.get(b"RF").is_ok()
    {
      let file_spec =
        object_id.map_or_else(|| object.clone(), Object::Reference);
      validate_file_spec(
        &file_spec,
        document,
        &mut structure_risks.attachments,
      )?;
    }
    validate_associated_files(
      dictionary,
      document,
      &mut structure_risks.attachments,
      "object",
    )?;
    if dictionary.get(b"FT").is_ok() {
      increment(&mut inventory.acro_form_field_count);
    }
    if name_deref_is(dictionary, b"Subtype", b"Image", document) {
      increment(&mut inventory.image_object_count);
    }
    if name_deref_is(dictionary, b"Subtype", b"Form", document) {
      increment(&mut inventory.form_x_object_count);
    }
    if name_deref_is(dictionary, b"Type", b"Metadata", document) {
      increment(&mut inventory.metadata_stream_count);
    }
    if name_deref_is(dictionary, b"Type", b"OCG", document) {
      increment(&mut inventory.optional_content_group_count);
    }
    if name_deref_is(dictionary, b"FT", b"Sig", document)
      || name_deref_is(dictionary, b"Type", b"Sig", document)
    {
      increment(&mut inventory.signature_count);
    }
    for (_, value) in dictionary {
      scan_risk_object(
        value,
        None,
        document,
        inventory,
        structure_risks,
        depth.saturating_add(1),
        scanned_nodes,
      )?;
    }
  }
  if let Object::Array(values) = object {
    for value in values {
      scan_risk_object(
        value,
        None,
        document,
        inventory,
        structure_risks,
        depth.saturating_add(1),
        scanned_nodes,
      )?;
    }
  }
  Ok(())
}

fn inventory_retained_action_object(
  object: &Object,
  object_id: Option<lopdf::ObjectId>,
  dictionary: &Dictionary,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  if !matches!(object, Object::Dictionary(_))
    || !is_retained_action_dictionary(dictionary, document)?
  {
    return Ok(());
  }
  if let Some(object_id) = object_id {
    if !risks.inventoried_action_ids.contains(&object_id) {
      inventory_action_entry(&Object::Reference(object_id), document, risks)?;
    }
  } else {
    inventory_action_entry(object, document, risks)?;
  }
  Ok(())
}

fn is_retained_action_dictionary(
  dictionary: &Dictionary,
  document: &Document,
) -> Result<bool, PdfInspectionError> {
  if name_deref_is(dictionary, b"Type", b"Action", document) {
    return Ok(true);
  }
  if dictionary.get(b"Type").is_ok() {
    return Ok(false);
  }
  let Some(action_kind) = optional_deref(dictionary, b"S", document)? else {
    return Ok(false);
  };
  let Ok(action_kind) = action_kind.as_name() else {
    return Ok(false);
  };
  Ok(KNOWN_ACTION_KINDS.contains(&action_kind))
}

const KNOWN_ACTION_KINDS: &[&[u8]] = &[
  b"GoTo",
  b"GoToR",
  b"GoToE",
  b"Launch",
  b"Thread",
  b"URI",
  b"Sound",
  b"Movie",
  b"Hide",
  b"Named",
  b"SubmitForm",
  b"ResetForm",
  b"ImportData",
  b"JavaScript",
  b"SetOCGState",
  b"Rendition",
  b"Trans",
  b"GoTo3DView",
];

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

fn name_deref_is(
  dictionary: &Dictionary,
  key: &[u8],
  expected: &[u8],
  document: &Document,
) -> bool {
  dictionary
    .get_deref(key, document)
    .ok()
    .and_then(|object| object.as_name().ok())
    .is_some_and(|name| name == expected)
}

fn optional_deref<'a>(
  dictionary: &'a Dictionary,
  key: &[u8],
  document: &'a Document,
) -> Result<Option<&'a Object>, PdfInspectionError> {
  match dictionary.get_deref(key, document) {
    Ok(object) => Ok(Some(object)),
    Err(lopdf::Error::DictKey(_)) => Ok(None),
    Err(_) => Err(invalid_document("PDF risk-bearing entry must resolve")),
  }
}

fn optional_entry<'a>(
  dictionary: &'a Dictionary,
  key: &[u8],
) -> Option<&'a Object> {
  dictionary.get(key).ok()
}

fn resolve_object<'a>(
  object: &'a Object,
  document: &'a Document,
) -> Result<&'a Object, PdfInspectionError> {
  document
    .dereference(object)
    .map(|(_, resolved)| resolved)
    .map_err(|_| invalid_document("PDF risk-bearing reference must resolve"))
}

fn validate_risk_structures(
  document: &Document,
  pages: &[ValidatedPage],
) -> Result<StructuralRiskInventory, PdfInspectionError> {
  let mut risks = StructuralRiskInventory::default();
  let catalog = document
    .catalog()
    .map_err(|_| invalid_document("PDF catalog must resolve"))?;
  if let Some(metadata) = optional_deref(catalog, b"Metadata", document)? {
    let metadata = metadata.as_stream().map_err(|_| {
      invalid_document("PDF catalog Metadata must resolve to a stream")
    })?;
    if !name_deref_is(&metadata.dict, b"Type", b"Metadata", document) {
      return Err(invalid_document(
        "PDF catalog Metadata stream must have type Metadata",
      ));
    }
  }
  if let Some(form) = optional_deref(catalog, b"AcroForm", document)? {
    let form = form.as_dict().map_err(|_| {
      invalid_document("PDF catalog AcroForm must resolve to a dictionary")
    })?;
    let fields =
      optional_deref(form, b"Fields", document)?.ok_or_else(|| {
        invalid_document("PDF catalog AcroForm must declare Fields")
      })?;
    validate_form_fields(fields, document, &mut risks)?;
    validate_additional_actions(form, document, "PDF AcroForm AA", &mut risks)?;
  }
  validate_catalog_name_trees(catalog, document, &mut risks)?;
  validate_optional_content(catalog, document)?;
  if let Some(actions) = optional_deref(catalog, b"AA", document)? {
    let actions = actions.as_dict().map_err(|_| {
      invalid_document("PDF catalog AA must resolve to an action dictionary")
    })?;
    for (_, action) in actions {
      inventory_action_entry(action, document, &mut risks)?;
    }
  }
  if let Some(open_action) = optional_entry(catalog, b"OpenAction") {
    let resolved_open_action = resolve_object(open_action, document)?;
    if resolved_open_action.as_dict().is_ok() {
      inventory_action_entry(open_action, document, &mut risks)?;
    } else if resolved_open_action.as_array().is_err()
      && resolved_open_action.as_name().is_err()
      && resolved_open_action.as_str().is_err()
    {
      return Err(invalid_document(
        "PDF catalog OpenAction must resolve to an action or destination",
      ));
    }
  }
  validate_outlines(catalog, document, &mut risks)?;
  for page in pages {
    let page = document.get_dictionary(page.id).map_err(|_| {
      invalid_document("PDF page dictionary became unavailable")
    })?;
    validate_additional_actions(page, document, "PDF page AA", &mut risks)?;
    validate_page_annotations(page, document, &mut risks)?;
  }
  Ok(risks)
}

fn validate_catalog_name_trees(
  catalog: &Dictionary,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let Some(names) = optional_deref(catalog, b"Names", document)? else {
    return Ok(());
  };
  let names = names.as_dict().map_err(|_| {
    invalid_document("PDF catalog Names must resolve to a dictionary")
  })?;
  for (key, value_kind) in [
    (b"EmbeddedFiles".as_slice(), NameTreeValueKind::EmbeddedFile),
    (b"JavaScript".as_slice(), NameTreeValueKind::Action),
  ] {
    let Some(name_tree) = optional_deref(names, key, document)? else {
      continue;
    };
    let name_tree = name_tree.as_dict().map_err(|_| {
      invalid_document("PDF catalog name trees must resolve to dictionaries")
    })?;
    validate_name_tree(
      name_tree,
      document,
      0,
      &mut BTreeSet::new(),
      value_kind,
      risks,
    )?;
  }
  Ok(())
}

fn validate_associated_files(
  owner: &Dictionary,
  document: &Document,
  attachments: &mut AttachmentInventory,
  context: &str,
) -> Result<(), PdfInspectionError> {
  let Some(attachment_array) = optional_deref(owner, b"AF", document)? else {
    return Ok(());
  };
  let file_specs = attachment_array.as_array().map_err(|_| {
    invalid_document(format!(
      "PDF {context} AF must resolve to an array of file specifications"
    ))
  })?;
  for file_spec in file_specs {
    validate_file_spec(file_spec, document, attachments)?;
  }
  Ok(())
}

fn validate_optional_content(
  catalog: &Dictionary,
  document: &Document,
) -> Result<(), PdfInspectionError> {
  let Some(optional_content) =
    optional_deref(catalog, b"OCProperties", document)?
  else {
    return Ok(());
  };
  let optional_content = optional_content.as_dict().map_err(|_| {
    invalid_document("PDF OCProperties must resolve to a dictionary")
  })?;
  let Some(groups) = optional_deref(optional_content, b"OCGs", document)?
  else {
    return Ok(());
  };
  let groups = groups.as_array().map_err(|_| {
    invalid_document("PDF OCProperties OCGs must resolve to an array")
  })?;
  for group in groups {
    let group = resolve_object(group, document)?.as_dict().map_err(|_| {
      invalid_document("PDF optional content groups must be dictionaries")
    })?;
    if !name_deref_is(group, b"Type", b"OCG", document) {
      return Err(invalid_document(
        "PDF optional content groups must have type OCG",
      ));
    }
  }
  Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
struct ActionRiskInventory {
  external: u32,
  javascript: u32,
  unsupported: u32,
}

#[derive(Debug, Default)]
struct StructuralRiskInventory {
  actions: ActionRiskInventory,
  attachments: AttachmentInventory,
  inventoried_action_ids: BTreeSet<lopdf::ObjectId>,
  inventoried_inline_action_pointers: BTreeSet<*const Dictionary>,
}

#[derive(Debug, Default)]
struct AttachmentInventory {
  node_count: usize,
  payload_ids: BTreeSet<lopdf::ObjectId>,
  spec_only_ids: BTreeSet<lopdf::ObjectId>,
  visited_spec_ids: BTreeSet<lopdf::ObjectId>,
  anonymous_spec_count: u32,
}

impl AttachmentInventory {
  fn charge_node(&mut self) -> Result<(), PdfInspectionError> {
    self.node_count = self.node_count.checked_add(1).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF attachment graph node count overflowed",
      )
    })?;
    if self.node_count > PDF_MAX_OBJECT_NODES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF attachment graph exceeds the object node limit",
      ));
    }
    Ok(())
  }

  fn begin_file_spec(
    &mut self,
    file_spec_id: Option<lopdf::ObjectId>,
  ) -> Result<bool, PdfInspectionError> {
    self.charge_node()?;
    let should_walk = match file_spec_id {
      Some(id) => self.visited_spec_ids.insert(id),
      None => true,
    };
    Ok(should_walk)
  }

  fn add_typed_streams(&mut self, document: &Document) {
    for (id, object) in &document.objects {
      if let Object::Stream(stream) = object
        && name_deref_is(&stream.dict, b"Type", b"EmbeddedFile", document)
      {
        self.payload_ids.insert(*id);
      }
    }
  }

  fn count(&self) -> u32 {
    u32::try_from(
      self
        .payload_ids
        .len()
        .saturating_add(self.spec_only_ids.len()),
    )
    .unwrap_or(u32::MAX)
    .saturating_add(self.anonymous_spec_count)
  }
}

#[derive(Clone, Copy, Debug)]
enum NameTreeValueKind {
  Action,
  EmbeddedFile,
}

impl ActionRiskInventory {
  const fn add(&mut self, other: Self) {
    self.external = self.external.saturating_add(other.external);
    self.javascript = self.javascript.saturating_add(other.javascript);
    self.unsupported = self.unsupported.saturating_add(other.unsupported);
  }
}

struct ActionValidator<'a, 'b> {
  document: &'a Document,
  attachments: &'b mut AttachmentInventory,
  inventoried_ids: &'b mut BTreeSet<lopdf::ObjectId>,
  inventoried_inline_pointers: &'b mut BTreeSet<*const Dictionary>,
  visited: BTreeSet<lopdf::ObjectId>,
  node_count: usize,
  risks: ActionRiskInventory,
}

fn validate_action_entry(
  action: &Object,
  document: &Document,
  attachments: &mut AttachmentInventory,
  inventoried_ids: &mut BTreeSet<lopdf::ObjectId>,
  inventoried_inline_pointers: &mut BTreeSet<*const Dictionary>,
) -> Result<ActionRiskInventory, PdfInspectionError> {
  let mut validator = ActionValidator {
    document,
    attachments,
    inventoried_ids,
    inventoried_inline_pointers,
    visited: BTreeSet::new(),
    node_count: 0,
    risks: ActionRiskInventory::default(),
  };
  validator.validate(action, 0)?;
  Ok(validator.risks)
}

fn inventory_action_entry(
  action: &Object,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let found = validate_action_entry(
    action,
    document,
    &mut risks.attachments,
    &mut risks.inventoried_action_ids,
    &mut risks.inventoried_inline_action_pointers,
  )?;
  risks.actions.add(found);
  Ok(())
}

impl ActionValidator<'_, '_> {
  fn validate(
    &mut self,
    action: &Object,
    depth: usize,
  ) -> Result<(), PdfInspectionError> {
    if depth > PDF_MAX_OBJECT_DEPTH {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF action chains exceed the object depth limit",
      ));
    }
    self.node_count = self.node_count.checked_add(1).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF action node count overflowed",
      )
    })?;
    if self.node_count > PDF_MAX_OBJECT_NODES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF action chains exceed the object node limit",
      ));
    }
    if let Object::Reference(id) = action {
      if !self.visited.insert(*id) {
        return Err(invalid_document(
          "PDF action chains must not contain cycles or duplicate nodes",
        ));
      }
      if !self.inventoried_ids.insert(*id) {
        return Ok(());
      }
    }
    let action_dictionary = resolve_object(action, self.document)?
      .as_dict()
      .map_err(|_| {
        invalid_document("PDF actions must resolve to dictionaries")
      })?;
    if !matches!(action, Object::Reference(_))
      && !self
        .inventoried_inline_pointers
        .insert(std::ptr::from_ref(action_dictionary))
    {
      return Ok(());
    }
    let action_kind = optional_deref(action_dictionary, b"S", self.document)?
      .ok_or_else(|| {
        invalid_document("PDF action dictionaries must declare S")
      })?
      .as_name()
      .map_err(|_| invalid_document("PDF action S must resolve to a name"))?;
    if action_kind == b"JavaScript" {
      increment(&mut self.risks.javascript);
    }
    if [
      b"URI".as_slice(),
      b"Launch",
      b"GoToR",
      b"SubmitForm",
      b"ImportData",
    ]
    .contains(&action_kind)
    {
      increment(&mut self.risks.external);
    }
    if !KNOWN_ACTION_KINDS.contains(&action_kind) {
      increment(&mut self.risks.unsupported);
    }
    // File-specification dictionaries may occur in current or future action
    // kinds. Follow any dictionary-valued F entry rather than maintaining a
    // brittle action-kind allowlist; simple string file specifications remain
    // valid external references and contain no embedded payload graph.
    if let Some(file_spec) = optional_entry(action_dictionary, b"F") {
      let resolved_file_spec = resolve_object(file_spec, self.document)?;
      if resolved_file_spec.as_dict().is_ok() {
        validate_file_spec(file_spec, self.document, self.attachments)?;
      } else if resolved_file_spec.as_str().is_err() {
        return Err(invalid_document(
          "PDF action F must be a string or file specification",
        ));
      }
    }
    if let Some(next) = optional_entry(action_dictionary, b"Next") {
      let resolved_next = resolve_object(next, self.document)?;
      if let Ok(actions) = resolved_next.as_array() {
        for next_action in actions {
          self.validate(next_action, depth.saturating_add(1))?;
        }
      } else {
        self.validate(next, depth.saturating_add(1))?;
      }
    }
    Ok(())
  }
}

fn validate_additional_actions(
  owner: &Dictionary,
  document: &Document,
  context: &str,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let Some(actions) = optional_entry(owner, b"AA") else {
    return Ok(());
  };
  let actions = resolve_object(actions, document)?.as_dict().map_err(|_| {
    invalid_document(format!("{context} must resolve to a dictionary"))
  })?;
  for (_, action) in actions {
    inventory_action_entry(action, document, risks)?;
  }
  Ok(())
}

fn validate_page_annotations(
  page: &Dictionary,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let Some(annotations) = optional_entry(page, b"Annots") else {
    return Ok(());
  };
  let annotations =
    resolve_object(annotations, document)?
      .as_array()
      .map_err(|_| {
        invalid_document("PDF page Annots must resolve to an array")
      })?;
  for annotation in annotations {
    let annotation =
      resolve_object(annotation, document)?
        .as_dict()
        .map_err(|_| {
          invalid_document("PDF annotations must resolve to dictionaries")
        })?;
    for key in [b"A".as_slice(), b"PA"] {
      if let Some(action) = optional_entry(annotation, key) {
        inventory_action_entry(action, document, risks)?;
      }
    }
    validate_additional_actions(
      annotation,
      document,
      "PDF annotation AA",
      risks,
    )?;
    let is_file_attachment =
      name_deref_is(annotation, b"Subtype", b"FileAttachment", document);
    if let Some(file_spec) = optional_entry(annotation, b"FS") {
      validate_file_spec(file_spec, document, &mut risks.attachments)?;
    } else if is_file_attachment {
      return Err(invalid_document(
        "PDF FileAttachment annotations must declare FS",
      ));
    }
  }
  Ok(())
}

struct FormFieldValidator<'a, 'b> {
  document: &'a Document,
  risks: &'b mut StructuralRiskInventory,
  visited: BTreeSet<lopdf::ObjectId>,
  node_count: usize,
}

fn validate_form_fields(
  fields: &Object,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let fields = resolve_object(fields, document)?.as_array().map_err(|_| {
    invalid_document("PDF AcroForm Fields must resolve to an array")
  })?;
  let mut validator = FormFieldValidator {
    document,
    risks,
    visited: BTreeSet::new(),
    node_count: 0,
  };
  for field in fields {
    validator.validate_field(field, None, None, 0)?;
  }
  Ok(())
}

impl FormFieldValidator<'_, '_> {
  fn validate_field(
    &mut self,
    field: &Object,
    expected_parent: Option<lopdf::ObjectId>,
    inherited_field_type: Option<&[u8]>,
    depth: usize,
  ) -> Result<(), PdfInspectionError> {
    if depth > PDF_MAX_OBJECT_DEPTH {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF AcroForm field trees exceed the object depth limit",
      ));
    }
    self.node_count = self.node_count.checked_add(1).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF AcroForm field node count overflowed",
      )
    })?;
    if self.node_count > PDF_MAX_OBJECT_NODES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF AcroForm field trees exceed the object node limit",
      ));
    }
    let field_id = field.as_reference().map_err(|_| {
      invalid_document("PDF AcroForm field entries must be indirect references")
    })?;
    if !self.visited.insert(field_id) {
      return Err(invalid_document(
        "PDF AcroForm field trees must not contain cycles or duplicate nodes",
      ));
    }
    let field_dictionary =
      self.document.get_dictionary(field_id).map_err(|_| {
        invalid_document(
          "PDF AcroForm field entries must resolve to dictionaries",
        )
      })?;
    validate_field_parent(field_dictionary, expected_parent)?;
    let field_type =
      match optional_deref(field_dictionary, b"FT", self.document)? {
        Some(value) => Some(value.as_name().map_err(|_| {
          invalid_document("PDF form-field FT must resolve to a name")
        })?),
        None => inherited_field_type,
      };
    validate_additional_actions(
      field_dictionary,
      self.document,
      "PDF form-field AA",
      self.risks,
    )?;
    if name_deref_is(field_dictionary, b"Subtype", b"Widget", self.document)
      && let Some(action) = optional_entry(field_dictionary, b"A")
    {
      inventory_action_entry(action, self.document, self.risks)?;
    }
    let Some(kids) = optional_entry(field_dictionary, b"Kids") else {
      if field_type.is_none() {
        return Err(invalid_document(
          "PDF terminal form fields must declare or inherit FT",
        ));
      }
      return Ok(());
    };
    let kids =
      resolve_object(kids, self.document)?
        .as_array()
        .map_err(|_| {
          invalid_document("PDF form-field Kids must resolve to an array")
        })?;
    if kids.is_empty() {
      return Err(invalid_document(
        "PDF form-field Kids must not be an empty array",
      ));
    }
    for kid in kids {
      self.validate_field(
        kid,
        Some(field_id),
        field_type,
        depth.saturating_add(1),
      )?;
    }
    Ok(())
  }
}

fn validate_field_parent(
  field: &Dictionary,
  expected_parent: Option<lopdf::ObjectId>,
) -> Result<(), PdfInspectionError> {
  match expected_parent {
    Some(parent) => {
      let actual = field
        .get(b"Parent")
        .and_then(Object::as_reference)
        .map_err(|_| {
          invalid_document("PDF child form fields must reference their Parent")
        })?;
      if actual != parent {
        return Err(invalid_document(
          "PDF form-field Parent reference is inconsistent",
        ));
      }
    }
    None if field.get(b"Parent").is_ok() => {
      return Err(invalid_document(
        "PDF root form fields must not declare Parent",
      ));
    }
    None => {}
  }
  Ok(())
}

fn validate_outlines(
  catalog: &Dictionary,
  document: &Document,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  let Some(outlines_entry) = optional_entry(catalog, b"Outlines") else {
    return Ok(());
  };
  let outlines_id = outlines_entry.as_reference().map_err(|_| {
    invalid_document("PDF catalog Outlines must be an indirect reference")
  })?;
  let outlines = document.get_dictionary(outlines_id).map_err(|_| {
    invalid_document("PDF catalog Outlines must resolve to a dictionary")
  })?;
  let first = optional_entry(outlines, b"First");
  let last = optional_entry(outlines, b"Last");
  let (Some(first), Some(last)) = (first, last) else {
    return if first.is_none() && last.is_none() {
      Ok(())
    } else {
      Err(invalid_document(
        "PDF outline dictionaries must declare First and Last together",
      ))
    };
  };
  if let Some(count) = optional_deref(outlines, b"Count", document)? {
    count.as_i64().map_err(|_| {
      invalid_document("PDF outline Count must resolve to an integer")
    })?;
  }
  let mut visited = BTreeSet::new();
  let mut node_count = 0usize;
  let actual_last = validate_outline_chain(
    first,
    outlines_id,
    document,
    &mut visited,
    &mut node_count,
    0,
    risks,
  )?;
  let declared_last = last.as_reference().map_err(|_| {
    invalid_document("PDF outline Last must be an indirect reference")
  })?;
  if actual_last != declared_last {
    return Err(invalid_document(
      "PDF outline Last reference is inconsistent",
    ));
  }
  Ok(())
}

fn validate_outline_chain(
  first: &Object,
  expected_parent: lopdf::ObjectId,
  document: &Document,
  visited: &mut BTreeSet<lopdf::ObjectId>,
  node_count: &mut usize,
  depth: usize,
  risks: &mut StructuralRiskInventory,
) -> Result<lopdf::ObjectId, PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF outline trees exceed the object depth limit",
    ));
  }
  let mut current = first;
  let mut previous_id = None;
  loop {
    *node_count = node_count.checked_add(1).ok_or_else(|| {
      error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF outline node count overflowed",
      )
    })?;
    if *node_count > PDF_MAX_OBJECT_NODES {
      return Err(error(
        PdfInspectionErrorCode::DocumentLimitExceeded,
        "PDF outline trees exceed the object node limit",
      ));
    }
    let current_id = current.as_reference().map_err(|_| {
      invalid_document("PDF outline items must be indirect references")
    })?;
    if !visited.insert(current_id) {
      return Err(invalid_document(
        "PDF outline trees must not contain cycles or duplicate nodes",
      ));
    }
    let item = document.get_dictionary(current_id).map_err(|_| {
      invalid_document("PDF outline items must resolve to dictionaries")
    })?;
    let parent =
      item
        .get(b"Parent")
        .and_then(Object::as_reference)
        .map_err(|_| {
          invalid_document("PDF outline items must reference Parent")
        })?;
    if parent != expected_parent {
      return Err(invalid_document(
        "PDF outline Parent reference is inconsistent",
      ));
    }
    match (previous_id, optional_entry(item, b"Prev")) {
      (None, None) => {}
      (Some(expected), Some(previous))
        if previous.as_reference().ok() == Some(expected) => {}
      _ => {
        return Err(invalid_document(
          "PDF outline Prev reference is inconsistent",
        ));
      }
    }
    optional_deref(item, b"Title", document)?
      .ok_or_else(|| invalid_document("PDF outline items must declare Title"))?
      .as_str()
      .map_err(|_| invalid_document("PDF outline Title must be a string"))?;
    if let Some(action) = optional_entry(item, b"A") {
      inventory_action_entry(action, document, risks)?;
    }
    let first_child = optional_entry(item, b"First");
    let last_child = optional_entry(item, b"Last");
    match (first_child, last_child) {
      (Some(first_child), Some(last_child)) => {
        let actual_last_child = validate_outline_chain(
          first_child,
          current_id,
          document,
          visited,
          node_count,
          depth.saturating_add(1),
          risks,
        )?;
        if last_child.as_reference().ok() != Some(actual_last_child) {
          return Err(invalid_document(
            "PDF outline child Last reference is inconsistent",
          ));
        }
      }
      (None, None) => {}
      _ => {
        return Err(invalid_document(
          "PDF outline items must declare First and Last together",
        ));
      }
    }
    let Some(next) = optional_entry(item, b"Next") else {
      return Ok(current_id);
    };
    previous_id = Some(current_id);
    current = next;
  }
}

fn validate_name_tree(
  tree: &Dictionary,
  document: &Document,
  depth: usize,
  visited: &mut BTreeSet<lopdf::ObjectId>,
  value_kind: NameTreeValueKind,
  risks: &mut StructuralRiskInventory,
) -> Result<(), PdfInspectionError> {
  if depth > PDF_MAX_OBJECT_DEPTH {
    return Err(error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF catalog name tree exceeds the object depth limit",
    ));
  }
  let names = optional_deref(tree, b"Names", document)?;
  let kids = optional_deref(tree, b"Kids", document)?;
  match (names, kids) {
    (Some(_), Some(_)) | (None, None) => Err(invalid_document(
      "PDF name-tree nodes must contain exactly one of Names or Kids",
    )),
    (Some(names), None) => {
      let names = names.as_array().map_err(|_| {
        invalid_document("PDF name-tree Names must be an array")
      })?;
      if names.len() % 2 != 0 {
        return Err(invalid_document(
          "PDF name-tree Names must contain key/value pairs",
        ));
      }
      for pair in names.chunks_exact(2) {
        pair
          .first()
          .and_then(|key| key.as_str().ok())
          .ok_or_else(|| {
            invalid_document("PDF name-tree keys must be strings")
          })?;
        let value = pair
          .get(1)
          .ok_or_else(|| invalid_document("PDF name-tree value is missing"))?;
        resolve_object(value, document)?.as_dict().map_err(|_| {
          invalid_document("PDF name-tree values must be dictionaries")
        })?;
        match value_kind {
          NameTreeValueKind::Action => {
            inventory_action_entry(value, document, risks)?;
          }
          NameTreeValueKind::EmbeddedFile => {
            validate_file_spec(value, document, &mut risks.attachments)?;
          }
        }
      }
      Ok(())
    }
    (None, Some(kids)) => {
      let kids = kids
        .as_array()
        .map_err(|_| invalid_document("PDF name-tree Kids must be an array"))?;
      for kid in kids {
        let kid_id = kid.as_reference().map_err(|_| {
          invalid_document("PDF name-tree Kids must be indirect references")
        })?;
        if !visited.insert(kid_id) {
          return Err(invalid_document(
            "PDF name trees must not contain cycles or duplicate nodes",
          ));
        }
        let resolved_kid = document.get_dictionary(kid_id).map_err(|_| {
          invalid_document("PDF name-tree Kids must resolve to dictionaries")
        })?;
        validate_name_tree(
          resolved_kid,
          document,
          depth.saturating_add(1),
          visited,
          value_kind,
          risks,
        )?;
      }
      Ok(())
    }
  }
}

const FILE_SPEC_NAME_KEYS: &[&[u8]] = &[b"F", b"UF", b"DOS", b"Mac", b"Unix"];

fn validate_file_spec_names(
  dictionary: &Dictionary,
  document: &Document,
) -> Result<bool, PdfInspectionError> {
  let mut has_file_name = false;
  for key in FILE_SPEC_NAME_KEYS {
    let Some(file_name) = optional_deref(dictionary, key, document)? else {
      continue;
    };
    file_name.as_str().map_err(|_| {
      invalid_document("PDF attachment file names must be strings")
    })?;
    has_file_name = true;
  }
  Ok(has_file_name)
}

fn validate_file_spec(
  file_spec: &Object,
  document: &Document,
  inventory: &mut AttachmentInventory,
) -> Result<(), PdfInspectionError> {
  let file_spec_id = file_spec.as_reference().ok();
  if !inventory.begin_file_spec(file_spec_id)? {
    return Ok(());
  }
  let dictionary =
    resolve_object(file_spec, document)?
      .as_dict()
      .map_err(|_| {
        invalid_document("PDF attachments must be file specifications")
      })?;
  if let Some(file_spec_type) = optional_deref(dictionary, b"Type", document)?
    && file_spec_type.as_name().ok() != Some(b"Filespec")
  {
    return Err(invalid_document(
      "PDF attachment Type must be Filespec when present",
    ));
  }
  let has_file_name = validate_file_spec_names(dictionary, document)?;
  let embedded_files = optional_deref(dictionary, b"EF", document)?
    .map(|embedded_files| {
      embedded_files.as_dict().map_err(|_| {
        invalid_document("PDF attachment EF must resolve to a dictionary")
      })
    })
    .transpose()?;
  if embedded_files.is_some_and(Dictionary::is_empty) {
    return Err(invalid_document(
      "PDF attachment EF must contain at least one payload",
    ));
  }
  if !has_file_name && embedded_files.is_none() {
    return Err(invalid_document(
      "PDF file specifications must declare a file name or EF payload",
    ));
  }
  let related_files = optional_deref(dictionary, b"RF", document)?;
  if related_files.is_some() && embedded_files.is_none() {
    return Err(invalid_document(
      "PDF attachment RF requires a corresponding EF dictionary",
    ));
  }
  let mut found_payload = false;
  if let Some(embedded_files) = embedded_files {
    for (key, payload) in embedded_files {
      if !FILE_SPEC_NAME_KEYS.contains(&key.as_slice()) {
        return Err(invalid_document(
          "PDF attachment EF keys must be file-name keys",
        ));
      }
      inventory.charge_node()?;
      inventory
        .payload_ids
        .insert(validate_embedded_file_payload(payload, document)?);
      found_payload = true;
    }
    if let Some(related_files) = related_files {
      let related_files = related_files.as_dict().map_err(|_| {
        invalid_document("PDF attachment RF must resolve to a dictionary")
      })?;
      for (key, related_array) in related_files {
        if embedded_files.get(key).is_err() {
          return Err(invalid_document(
            "PDF attachment RF keys must also be present in EF",
          ));
        }
        let related_array = resolve_object(related_array, document)?
          .as_array()
          .map_err(|_| {
            invalid_document(
              "PDF attachment RF values must be related-file arrays",
            )
          })?;
        if related_array.len() % 2 != 0 {
          return Err(invalid_document(
            "PDF related-file arrays must contain name/payload pairs",
          ));
        }
        for pair in related_array.chunks_exact(2) {
          inventory.charge_node()?;
          pair
            .first()
            .and_then(|name| name.as_str().ok())
            .ok_or_else(|| {
              invalid_document("PDF related-file names must be strings")
            })?;
          let payload = pair.get(1).ok_or_else(|| {
            invalid_document("PDF related-file payload is missing")
          })?;
          inventory
            .payload_ids
            .insert(validate_embedded_file_payload(payload, document)?);
          found_payload = true;
        }
      }
    }
  }
  if !found_payload {
    add_spec_only_attachment(file_spec_id, inventory);
  }
  Ok(())
}

fn validate_embedded_file_payload(
  payload: &Object,
  document: &Document,
) -> Result<lopdf::ObjectId, PdfInspectionError> {
  let payload_id = payload.as_reference().map_err(|_| {
    invalid_document("PDF attachment payloads must be indirect streams")
  })?;
  let stream = document.get_object(payload_id).map_err(|_| {
    invalid_document("PDF attachment stream reference must resolve")
  })?;
  let stream = stream.as_stream().map_err(|_| {
    invalid_document("PDF attachment payloads must resolve to streams")
  })?;
  if let Some(stream_type) = optional_deref(&stream.dict, b"Type", document)?
    && stream_type.as_name().ok() != Some(b"EmbeddedFile")
  {
    return Err(invalid_document(
      "PDF attachment stream Type must be EmbeddedFile when present",
    ));
  }
  Ok(payload_id)
}

fn add_spec_only_attachment(
  file_spec_id: Option<lopdf::ObjectId>,
  inventory: &mut AttachmentInventory,
) {
  if let Some(file_spec_id) = file_spec_id {
    inventory.spec_only_ids.insert(file_spec_id);
  } else {
    increment(&mut inventory.anonymous_spec_count);
  }
}

fn annotation_count(
  dictionary: &Dictionary,
  document: &Document,
) -> Result<u32, PdfInspectionError> {
  let Some(object) = optional_deref(dictionary, b"Annots", document)? else {
    return Ok(0);
  };
  let annotations = object.as_array().map_err(|_| {
    invalid_document("PDF page Annots must resolve to an array")
  })?;
  for annotation in annotations {
    resolve_object(annotation, document)?
      .as_dict()
      .map_err(|_| {
        invalid_document(
          "PDF page annotation entries must resolve to dictionaries",
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
  let Some(info) = optional_deref(&document.trailer, b"Info", document)? else {
    return Ok(0);
  };
  let info = info.as_dict().map_err(|_| {
    invalid_document("PDF trailer Info must resolve to a dictionary")
  })?;
  u32::try_from(info.len()).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF document Info entry count overflowed",
    )
  })
}

fn catalog_xfa_count(document: &Document) -> Result<u32, PdfInspectionError> {
  let catalog = document
    .catalog()
    .map_err(|_| invalid_document("PDF catalog must resolve"))?;
  let Some(form) = optional_deref(catalog, b"AcroForm", document)? else {
    return Ok(0);
  };
  let form = form.as_dict().map_err(|_| {
    invalid_document("PDF catalog AcroForm must be a dictionary")
  })?;
  let Some(xfa) = optional_deref(form, b"XFA", document)? else {
    return Ok(0);
  };
  if xfa.as_stream().is_ok() {
    return Ok(1);
  }
  let packets = xfa.as_array().map_err(|_| {
    invalid_document("PDF AcroForm XFA must be a stream or packet array")
  })?;
  if packets.len() % 2 != 0 {
    return Err(invalid_document(
      "PDF AcroForm XFA packet arrays must contain name/stream pairs",
    ));
  }
  for pair in packets.chunks_exact(2) {
    pair
      .first()
      .and_then(|name| name.as_str().ok())
      .ok_or_else(|| {
        invalid_document("PDF XFA packet names must be strings")
      })?;
    let stream = pair
      .get(1)
      .ok_or_else(|| invalid_document("PDF XFA packet stream is missing"))?;
    resolve_object(stream, document).and_then(|object| {
      object.as_stream().map_err(|_| {
        invalid_document("PDF XFA packets must resolve to streams")
      })
    })?;
  }
  u32::try_from(packets.chunks_exact(2).len()).map_err(|_| {
    error(
      PdfInspectionErrorCode::DocumentLimitExceeded,
      "PDF XFA packet count overflowed",
    )
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::*;
  use lopdf::dictionary;

  const MINIMAL_PDF: &[u8] =
    include_bytes!("../tests/fixtures/minimal-text.pdf");
  const RISKY_PDF: &[u8] =
    include_bytes!("../tests/fixtures/risky-structures.pdf");

  fn add_untyped_attachment(
    document: &mut Document,
  ) -> (lopdf::ObjectId, lopdf::ObjectId) {
    let payload_id = document.add_object(Object::Stream(lopdf::Stream::new(
      Dictionary::new(),
      b"attachment".to_vec(),
    )));
    let mut embedded_files = Dictionary::new();
    embedded_files.set("F", Object::Reference(payload_id));
    let mut file_spec = Dictionary::new();
    file_spec.set("F", Object::string_literal("attachment.txt"));
    file_spec.set("EF", Object::Dictionary(embedded_files));
    let file_spec_id = document.add_object(Object::Dictionary(file_spec));
    (file_spec_id, payload_id)
  }

  fn set_embedded_file_name_tree(
    document: &mut Document,
    file_spec_id: lopdf::ObjectId,
  ) {
    let mut embedded_files = Dictionary::new();
    embedded_files.set(
      "Names",
      vec![
        Object::string_literal("attachment.txt"),
        Object::Reference(file_spec_id),
      ],
    );
    let embedded_files_id =
      document.add_object(Object::Dictionary(embedded_files));
    let mut names = Dictionary::new();
    names.set("EmbeddedFiles", Object::Reference(embedded_files_id));
    document
      .catalog_mut()
      .unwrap()
      .set("Names", Object::Dictionary(names));
  }

  fn inspect_document(document: &mut Document) -> PdfInspection {
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    inspect_pdf(&bytes).unwrap()
  }

  fn first_page_id(document: &Document) -> lopdf::ObjectId {
    *document.get_pages().values().next().unwrap()
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
      vec![PdfInspectionGap::PageContentNotObserved]
    );
  }

  #[test]
  fn complete_renderer_observation_can_close_inspection_coverage() {
    let inspection = inspect_pdf_with_observations(
      MINIMAL_PDF,
      vec![PdfPageObservation {
        page_index: 0,
        width_points: 612.0,
        height_points: 792.0,
        text: String::from("Public fixture"),
        glyphs: vec![PdfGlyphObservation {
          start: 0,
          end: 14,
          bounds: PdfRect {
            left: 72.0,
            bottom: 700.0,
            right: 108.0,
            top: 712.0,
          },
          source: PdfGlyphSource::EmbeddedText,
        }],
        rendered: true,
        text_layer: PdfTextLayerCoverage::Complete,
        ocr: PdfOcrCoverage::Complete,
        image_count: 0,
      }],
    )
    .unwrap();
    assert_eq!(
      inspection.coverage.status,
      PdfInspectionCoverageStatus::Full
    );
    assert!(inspection.coverage.gaps.is_empty());
  }

  #[test]
  fn text_layer_alone_does_not_claim_visual_coverage() {
    let inspection = inspect_pdf_with_observations(
      MINIMAL_PDF,
      vec![PdfPageObservation {
        page_index: 0,
        width_points: 612.0,
        height_points: 792.0,
        text: String::from("Public fixture"),
        glyphs: vec![PdfGlyphObservation {
          start: 0,
          end: 14,
          bounds: PdfRect {
            left: 72.0,
            bottom: 700.0,
            right: 144.0,
            top: 712.0,
          },
          source: PdfGlyphSource::EmbeddedText,
        }],
        rendered: true,
        text_layer: PdfTextLayerCoverage::Complete,
        ocr: PdfOcrCoverage::NotRun,
        image_count: 0,
      }],
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
      width_points: 100.0,
      height_points: 100.0,
      text: String::from("😀"),
      glyphs: vec![PdfGlyphObservation {
        start: 0,
        end: 1,
        bounds: PdfRect {
          left: 0.0,
          bottom: 0.0,
          right: 101.0,
          top: 10.0,
        },
        source: PdfGlyphSource::EmbeddedText,
      }],
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::NotRun,
      image_count: 0,
    };
    let error =
      inspect_pdf_with_observations(MINIMAL_PDF, vec![invalid]).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidObservation);
  }

  #[test]
  fn rejects_documents_above_the_input_limit_before_parsing() {
    let bytes = vec![0; PDF_DOCUMENT_MAX_BYTES + 1];
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::DocumentLimitExceeded);
  }

  #[test]
  fn observations_json_limit_is_inclusive_and_fails_before_deserialization() {
    validate_pdf_observations_json_byte_length(PDF_OBSERVATIONS_JSON_MAX_BYTES)
      .unwrap();
    let error = validate_pdf_observations_json_byte_length(
      PDF_OBSERVATIONS_JSON_MAX_BYTES + 1,
    )
    .unwrap_err();
    assert_eq!(
      error.code(),
      PdfInspectionErrorCode::ObservationLimitExceeded
    );
  }

  #[test]
  fn aggregate_loaded_payload_limit_rejects_across_objects() {
    let mut document = Document::new();
    document
      .add_object(Object::String(b"ab".to_vec(), lopdf::StringFormat::Literal));
    document
      .add_object(Object::String(b"cd".to_vec(), lopdf::StringFormat::Literal));
    let error = validate_loaded_payload(&document, 3).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::DocumentLimitExceeded);
  }

  #[test]
  fn inventories_incremental_markers_and_trailing_retained_bytes() {
    let document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut incremental = MINIMAL_PDF.to_vec();
    incremental.extend_from_slice(
      format!("\nstartxref\n{}\n%%EOF\n", document.xref_start).as_bytes(),
    );
    let incremental_inspection = inspect_pdf(&incremental).unwrap();
    assert_eq!(incremental_inspection.risks.incremental_revision_count, 1);
    assert!(
      incremental_inspection
        .coverage
        .gaps
        .contains(&PdfInspectionGap::RetainedDocumentBytes)
    );

    let mut trailing = MINIMAL_PDF.to_vec();
    trailing.extend_from_slice(b"\nretained bytes\n");
    let trailing_inspection = inspect_pdf(&trailing).unwrap();
    assert_eq!(
      trailing_inspection.risks.trailing_non_whitespace_byte_count,
      13
    );
    assert!(
      trailing_inspection
        .coverage
        .gaps
        .contains(&PdfInspectionGap::RetainedDocumentBytes)
    );

    let fake_marker_suffixes = [
      b"\nsecret retained bytes%%EOF\n".to_vec(),
      format!(
        "\nsecret retained bytes\nstartxref \r\n {}\t\n%%EOF\n",
        document.xref_start
      )
      .into_bytes(),
      format!(
        "\nsecret retained bytes\nstartxref\n{}\n%%EOF\nstartxref\r\n{}\r\n%%EOF\n",
        document.xref_start, document.xref_start
      )
      .into_bytes(),
    ];
    for suffix in fake_marker_suffixes {
      let mut adversarial = MINIMAL_PDF.to_vec();
      adversarial.extend_from_slice(&suffix);
      let result = inspect_pdf_with_observations(
        &adversarial,
        vec![PdfPageObservation {
          page_index: 0,
          width_points: 612.0,
          height_points: 792.0,
          text: String::new(),
          glyphs: Vec::new(),
          rendered: true,
          text_layer: PdfTextLayerCoverage::Complete,
          ocr: PdfOcrCoverage::Complete,
          image_count: 0,
        }],
      );
      match result {
        Ok(inspection) => {
          assert_eq!(
            inspection.coverage.status,
            PdfInspectionCoverageStatus::Partial
          );
          assert!(
            inspection
              .coverage
              .gaps
              .contains(&PdfInspectionGap::RetainedDocumentBytes)
          );
        }
        Err(error) => {
          assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
        }
      }
    }
  }

  #[test]
  fn malformed_risk_bearing_references_fail_closed() {
    let mut annotations_document = Document::load_mem(MINIMAL_PDF).unwrap();
    let page_id = *annotations_document.get_pages().values().next().unwrap();
    annotations_document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("Annots", 1i64);
    let mut annotations_bytes = Vec::new();
    annotations_document
      .save_to(&mut annotations_bytes)
      .unwrap();
    let annotations_error = inspect_pdf(&annotations_bytes).unwrap_err();
    assert_eq!(
      annotations_error.code(),
      PdfInspectionErrorCode::InvalidDocument
    );

    let mut metadata_document = Document::load_mem(MINIMAL_PDF).unwrap();
    metadata_document
      .catalog_mut()
      .unwrap()
      .set("Metadata", 1i64);
    let mut metadata_bytes = Vec::new();
    metadata_document.save_to(&mut metadata_bytes).unwrap();
    let metadata_error = inspect_pdf(&metadata_bytes).unwrap_err();
    assert_eq!(
      metadata_error.code(),
      PdfInspectionErrorCode::InvalidDocument
    );
  }

  #[test]
  fn rejects_malformed_page_actions_instead_of_silently_ignoring_them() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let page_id = *document.get_pages().values().next().unwrap();
    let mut malformed_action = Dictionary::new();
    malformed_action.set("S", 1i64);
    malformed_action
      .set("URI", Object::string_literal("https://example.invalid"));
    let mut additional_actions = Dictionary::new();
    additional_actions.set("O", Object::Dictionary(malformed_action));
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("AA", Object::Dictionary(additional_actions));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn rejects_malformed_form_field_kids() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut field = Dictionary::new();
    field.set("FT", Object::Name(b"Tx".to_vec()));
    field.set("Kids", vec![42.into()]);
    let field_id = document.add_object(Object::Dictionary(field));
    let mut form = Dictionary::new();
    form.set("Fields", vec![Object::Reference(field_id)]);
    let form_id = document.add_object(Object::Dictionary(form));
    document
      .catalog_mut()
      .unwrap()
      .set("AcroForm", Object::Reference(form_id));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn accepts_valid_nested_fields_and_bounded_next_action_chains() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut root_field = Dictionary::new();
    root_field.set("FT", Object::Name(b"Tx".to_vec()));
    let root_id = document.add_object(Object::Dictionary(root_field));
    let mut child_field = Dictionary::new();
    child_field.set("Parent", Object::Reference(root_id));
    child_field.set("T", Object::string_literal("public_child"));
    let child_id = document.add_object(Object::Dictionary(child_field));
    document
      .get_dictionary_mut(root_id)
      .unwrap()
      .set("Kids", vec![Object::Reference(child_id)]);
    let mut form = Dictionary::new();
    form.set("Fields", vec![Object::Reference(root_id)]);
    let form_id = document.add_object(Object::Dictionary(form));
    document
      .catalog_mut()
      .unwrap()
      .set("AcroForm", Object::Reference(form_id));

    let mut next_action = Dictionary::new();
    next_action.set("S", Object::Name(b"VendorPrivate".to_vec()));
    let next_id = document.add_object(Object::Dictionary(next_action));
    let mut root_action = Dictionary::new();
    root_action.set("S", Object::Name(b"URI".to_vec()));
    root_action.set("URI", Object::string_literal("https://example.invalid"));
    root_action.set("Next", vec![Object::Reference(next_id)]);
    let page_id = *document.get_pages().values().next().unwrap();
    let mut additional_actions = Dictionary::new();
    additional_actions.set("O", Object::Dictionary(root_action));
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("AA", Object::Dictionary(additional_actions));

    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let inspection = inspect_pdf(&bytes).unwrap();
    assert!(inspection.risks.external_action_count >= 1);
    assert_eq!(inspection.risks.unsupported_action_count, 1);
  }

  #[test]
  fn accepts_nested_outline_annotation_and_name_tree_actions() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();

    let mut uri_action = Dictionary::new();
    uri_action.set("S", Object::Name(b"URI".to_vec()));
    uri_action.set("URI", Object::string_literal("https://example.invalid"));
    let uri_action_id = document.add_object(Object::Dictionary(uri_action));

    let mut javascript_action = Dictionary::new();
    javascript_action.set("S", Object::Name(b"JavaScript".to_vec()));
    javascript_action.set("JS", Object::string_literal("app.alert('test')"));
    javascript_action.set("Next", Object::Reference(uri_action_id));
    let javascript_action_id =
      document.add_object(Object::Dictionary(javascript_action));
    let mut javascript_tree = Dictionary::new();
    javascript_tree.set(
      "Names",
      vec![
        Object::string_literal("startup"),
        Object::Reference(javascript_action_id),
      ],
    );
    let javascript_tree_id =
      document.add_object(Object::Dictionary(javascript_tree));
    let mut names = Dictionary::new();
    names.set("JavaScript", Object::Reference(javascript_tree_id));
    document
      .catalog_mut()
      .unwrap()
      .set("Names", Object::Dictionary(names));

    let outlines_id =
      document.add_object(Object::Dictionary(Dictionary::new()));
    let mut top_item = Dictionary::new();
    top_item.set("Parent", Object::Reference(outlines_id));
    top_item.set("Title", Object::string_literal("Top"));
    let top_item_id = document.add_object(Object::Dictionary(top_item));
    let mut child_item = Dictionary::new();
    child_item.set("Parent", Object::Reference(top_item_id));
    child_item.set("Title", Object::string_literal("Child"));
    child_item.set("A", Object::Reference(uri_action_id));
    let child_item_id = document.add_object(Object::Dictionary(child_item));
    document
      .get_dictionary_mut(top_item_id)
      .unwrap()
      .set("First", Object::Reference(child_item_id));
    document
      .get_dictionary_mut(top_item_id)
      .unwrap()
      .set("Last", Object::Reference(child_item_id));
    let outlines = document.get_dictionary_mut(outlines_id).unwrap();
    outlines.set("First", Object::Reference(top_item_id));
    outlines.set("Last", Object::Reference(top_item_id));
    outlines.set("Count", 2i64);
    document
      .catalog_mut()
      .unwrap()
      .set("Outlines", Object::Reference(outlines_id));

    let mut annotation = Dictionary::new();
    annotation.set("Type", Object::Name(b"Annot".to_vec()));
    annotation.set("Subtype", Object::Name(b"Link".to_vec()));
    annotation.set("Rect", vec![0.into(), 0.into(), 10.into(), 10.into()]);
    annotation.set("A", Object::Reference(uri_action_id));
    let annotation_id = document.add_object(Object::Dictionary(annotation));
    let page_id = *document.get_pages().values().next().unwrap();
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("Annots", vec![Object::Reference(annotation_id)]);

    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let inspection = inspect_pdf(&bytes).unwrap();
    assert_eq!(inspection.risks.annotation_count, 1);
    assert_eq!(inspection.risks.javascript_action_count, 1);
    assert_eq!(inspection.risks.external_action_count, 1);
    assert_eq!(inspection.risks.unsupported_action_count, 0);
  }

  #[test]
  fn action_inventory_ignores_non_action_s_entries() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut viewer_preferences = Dictionary::new();
    viewer_preferences.set("S", Object::Name(b"VendorLayoutStyle".to_vec()));
    document
      .catalog_mut()
      .unwrap()
      .set("ViewerPreferences", Object::Dictionary(viewer_preferences));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let inspection = inspect_pdf(&bytes).unwrap();
    assert_eq!(inspection.risks.unsupported_action_count, 0);
  }

  #[test]
  fn rejects_inconsistent_outline_sibling_links() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let outlines_id =
      document.add_object(Object::Dictionary(Dictionary::new()));
    let mut first = Dictionary::new();
    first.set("Parent", Object::Reference(outlines_id));
    first.set("Title", Object::string_literal("First"));
    let first_id = document.add_object(Object::Dictionary(first));
    let mut second = Dictionary::new();
    second.set("Parent", Object::Reference(outlines_id));
    second.set("Title", Object::string_literal("Second"));
    second.set("Prev", Object::Reference(outlines_id));
    let second_id = document.add_object(Object::Dictionary(second));
    document
      .get_dictionary_mut(first_id)
      .unwrap()
      .set("Next", Object::Reference(second_id));
    let outlines = document.get_dictionary_mut(outlines_id).unwrap();
    outlines.set("First", Object::Reference(first_id));
    outlines.set("Last", Object::Reference(second_id));
    document
      .catalog_mut()
      .unwrap()
      .set("Outlines", Object::Reference(outlines_id));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn rejects_action_next_cycles() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let action_id = document.add_object(Object::Dictionary(Dictionary::new()));
    let action = document.get_dictionary_mut(action_id).unwrap();
    action.set("S", Object::Name(b"Named".to_vec()));
    action.set("N", Object::Name(b"NextPage".to_vec()));
    action.set("Next", Object::Reference(action_id));
    let mut additional_actions = Dictionary::new();
    additional_actions.set("O", Object::Reference(action_id));
    let page_id = *document.get_pages().values().next().unwrap();
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("AA", Object::Dictionary(additional_actions));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
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
    let error = validate_loaded_object_table(&document).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn rejects_page_trees_that_silently_drop_declared_pages() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let pages_id = document
      .catalog()
      .unwrap()
      .get(b"Pages")
      .unwrap()
      .as_reference()
      .unwrap();
    let pages = document.get_dictionary_mut(pages_id).unwrap();
    pages.set("Kids", vec![Object::Reference((999_999, 0))]);
    pages.set("Count", 1i64);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let error = inspect_pdf(&bytes).unwrap_err();
    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn accepts_modern_xref_and_object_stream_documents() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut bytes = Vec::new();
    document.save_modern(&mut bytes).unwrap();
    let inspection = inspect_pdf(&bytes).unwrap();
    assert_eq!(inspection.pdf_version, "1.5");
    assert_eq!(inspection.page_count, 1);
  }

  #[test]
  fn complete_text_layers_reject_ocr_only_and_mixed_source_coverage() {
    let ocr_glyph = PdfGlyphObservation {
      start: 6,
      end: 14,
      bounds: PdfRect {
        left: 88.0,
        bottom: 700.0,
        right: 108.0,
        top: 712.0,
      },
      source: PdfGlyphSource::Ocr,
    };
    let ocr_only = vec![PdfGlyphObservation {
      start: 0,
      bounds: PdfRect {
        left: 72.0,
        ..ocr_glyph.bounds.clone()
      },
      ..ocr_glyph.clone()
    }];
    let mixed = vec![
      PdfGlyphObservation {
        start: 0,
        end: 6,
        bounds: PdfRect {
          left: 72.0,
          bottom: 700.0,
          right: 88.0,
          top: 712.0,
        },
        source: PdfGlyphSource::EmbeddedText,
      },
      ocr_glyph,
    ];
    for glyphs in [ocr_only, mixed] {
      let observation = PdfPageObservation {
        page_index: 0,
        width_points: 612.0,
        height_points: 792.0,
        text: String::from("Public fixture"),
        glyphs,
        rendered: true,
        text_layer: PdfTextLayerCoverage::Complete,
        ocr: PdfOcrCoverage::Complete,
        image_count: 0,
      };
      let error = inspect_pdf_with_observations(MINIMAL_PDF, vec![observation])
        .unwrap_err();
      assert_eq!(error.code(), PdfInspectionErrorCode::InvalidObservation);
    }
  }

  #[test]
  fn rejects_false_full_observations_and_wrong_page_geometry() {
    let incomplete = PdfPageObservation {
      page_index: 0,
      width_points: 612.0,
      height_points: 792.0,
      text: String::from("Public fixture"),
      glyphs: vec![PdfGlyphObservation {
        start: 0,
        end: 6,
        bounds: PdfRect {
          left: 72.0,
          bottom: 700.0,
          right: 108.0,
          top: 712.0,
        },
        source: PdfGlyphSource::EmbeddedText,
      }],
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    };
    let incomplete_error =
      inspect_pdf_with_observations(MINIMAL_PDF, vec![incomplete]).unwrap_err();
    assert_eq!(
      incomplete_error.code(),
      PdfInspectionErrorCode::InvalidObservation
    );

    let wrong_geometry = PdfPageObservation {
      page_index: 0,
      width_points: 1.0,
      height_points: 1.0,
      text: String::new(),
      glyphs: Vec::new(),
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    };
    let geometry_error =
      inspect_pdf_with_observations(MINIMAL_PDF, vec![wrong_geometry])
        .unwrap_err();
    assert_eq!(
      geometry_error.code(),
      PdfInspectionErrorCode::InvalidObservation
    );
  }

  #[test]
  fn applies_inherited_crop_box_rotation_and_user_unit_to_page_geometry() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let page_id = *document.get_pages().values().next().unwrap();
    let page = document.get_dictionary_mut(page_id).unwrap();
    page.set("CropBox", vec![0.into(), 0.into(), 300.into(), 400.into()]);
    page.set("Rotate", 90i64);
    page.set("UserUnit", 2i64);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let observation = PdfPageObservation {
      page_index: 0,
      width_points: 800.0,
      height_points: 600.0,
      text: String::new(),
      glyphs: Vec::new(),
      rendered: true,
      text_layer: PdfTextLayerCoverage::Complete,
      ocr: PdfOcrCoverage::Complete,
      image_count: 0,
    };
    let inspection =
      inspect_pdf_with_observations(&bytes, vec![observation]).unwrap();
    assert_eq!(
      inspection.coverage.status,
      PdfInspectionCoverageStatus::Full
    );
  }

  #[test]
  fn inventories_names_only_attachment_without_stream_type() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    set_embedded_file_name_tree(&mut document, file_spec_id);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_unreferenced_file_spec_without_stream_type() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    add_untyped_attachment(&mut document);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_inline_file_spec_on_an_arbitrary_object() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let payload_id = document.add_object(Object::Stream(lopdf::Stream::new(
      Dictionary::new(),
      b"inline attachment".to_vec(),
    )));
    let mut embedded_files = Dictionary::new();
    embedded_files.set("F", Object::Reference(payload_id));
    let mut file_spec = Dictionary::new();
    file_spec.set("EF", Object::Dictionary(embedded_files));
    document.add_object(lopdf::dictionary! {
      "Type" => "CustomOwner",
      "Payload" => Object::Dictionary(file_spec),
    });

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_af_only_file_spec_without_a_payload() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut file_spec = Dictionary::new();
    file_spec.set("Type", Object::Name(b"Filespec".to_vec()));
    file_spec.set("F", Object::string_literal("external.txt"));
    let file_spec_id = document.add_object(Object::Dictionary(file_spec));
    document
      .catalog_mut()
      .unwrap()
      .set("AF", vec![Object::Reference(file_spec_id)]);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_file_attachment_annotation_file_spec() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    let annotation_id = document.add_object(lopdf::dictionary! {
      "Type" => "Annot",
      "Subtype" => "FileAttachment",
      "Rect" => vec![0.into(), 0.into(), 1.into(), 1.into()],
      "FS" => file_spec_id,
    });
    let page_id = first_page_id(&document);
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("Annots", vec![Object::Reference(annotation_id)]);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_related_file_payloads() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    let related_payload_id = document.add_object(Object::Stream(
      lopdf::Stream::new(Dictionary::new(), b"related attachment".to_vec()),
    ));
    let mut related_files = Dictionary::new();
    related_files.set(
      "F",
      vec![
        Object::string_literal("related.txt"),
        Object::Reference(related_payload_id),
      ],
    );
    document
      .get_dictionary_mut(file_spec_id)
      .unwrap()
      .set("RF", Object::Dictionary(related_files));
    document
      .catalog_mut()
      .unwrap()
      .set("AF", vec![Object::Reference(file_spec_id)]);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 2);
  }

  #[test]
  fn inventories_embedded_file_specs_reached_through_external_actions() {
    for (action_kind, external_count) in [
      ("Launch", 1),
      ("GoToR", 1),
      ("SubmitForm", 1),
      ("ImportData", 1),
      ("GoToE", 0),
    ] {
      let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
      let (file_spec_id, _) = add_untyped_attachment(&mut document);
      let action_id = document.add_object(lopdf::dictionary! {
        "Type" => "Action",
        "S" => action_kind,
        "F" => file_spec_id,
      });
      document
        .catalog_mut()
        .unwrap()
        .set("OpenAction", Object::Reference(action_id));

      let inspection = inspect_document(&mut document);

      assert_eq!(inspection.risks.embedded_file_count, 1, "{action_kind}");
      assert_eq!(
        inspection.risks.external_action_count, external_count,
        "{action_kind}"
      );
    }
  }

  #[test]
  fn rejects_non_file_spec_action_file_values() {
    for invalid_file in [
      Object::Array(Vec::new()),
      Object::Stream(lopdf::Stream::new(Dictionary::new(), Vec::new())),
      Object::Dictionary(lopdf::dictionary! { "S" => "Launch" }),
      Object::Dictionary(
        lopdf::dictionary! { "F" => Object::Array(Vec::new()) },
      ),
      Object::Dictionary(
        lopdf::dictionary! { "EF" => Object::Dictionary(Dictionary::new()) },
      ),
    ] {
      let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
      let invalid_file_id = document.add_object(invalid_file);
      let action_id = document.add_object(lopdf::dictionary! {
        "Type" => "Action",
        "S" => "Launch",
        "F" => invalid_file_id,
      });
      document
        .catalog_mut()
        .unwrap()
        .set("OpenAction", Object::Reference(action_id));
      let mut bytes = Vec::new();
      document.save_to(&mut bytes).unwrap();

      let error = inspect_pdf(&bytes).unwrap_err();

      assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
    }
  }

  #[test]
  fn bounds_attachment_graph_walks_before_dereferencing() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    let mut inventory = AttachmentInventory {
      node_count: PDF_MAX_OBJECT_NODES,
      ..AttachmentInventory::default()
    };

    let error = validate_file_spec(
      &Object::Reference(file_spec_id),
      &document,
      &mut inventory,
    )
    .unwrap_err();

    assert_eq!(error.code(), PdfInspectionErrorCode::DocumentLimitExceeded);
    assert!(inventory.payload_ids.is_empty());
  }

  #[test]
  fn rejects_related_files_without_matching_embedded_file_entries() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let payload_id = document.add_object(Object::Stream(lopdf::Stream::new(
      Dictionary::new(),
      Vec::new(),
    )));
    let mut related_files = Dictionary::new();
    related_files.set(
      "F",
      vec![
        Object::string_literal("related.txt"),
        Object::Reference(payload_id),
      ],
    );
    let mut file_spec = Dictionary::new();
    file_spec.set("RF", Object::Dictionary(related_files));
    let file_spec_id = document.add_object(Object::Dictionary(file_spec));
    document
      .catalog_mut()
      .unwrap()
      .set("AF", vec![Object::Reference(file_spec_id)]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();

    let error = inspect_pdf(&bytes).unwrap_err();

    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn inventories_and_deduplicates_page_and_annotation_associated_files() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    let annotation_id = document.add_object(lopdf::dictionary! {
      "Type" => "Annot",
      "Subtype" => "Text",
      "Rect" => vec![0.into(), 0.into(), 1.into(), 1.into()],
      "AF" => vec![Object::Reference(file_spec_id)],
    });
    let page_id = first_page_id(&document);
    let page = document.get_dictionary_mut(page_id).unwrap();
    page.set("AF", vec![Object::Reference(file_spec_id)]);
    page.set("Annots", vec![Object::Reference(annotation_id)]);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_associated_files_on_arbitrary_pdf_objects() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    document.add_object(lopdf::dictionary! {
      "Type" => "CustomOwner",
      "AF" => vec![Object::Reference(file_spec_id)],
    });

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn rejects_file_attachment_annotation_without_file_spec() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let annotation_id = document.add_object(lopdf::dictionary! {
      "Type" => "Annot",
      "Subtype" => "FileAttachment",
      "Rect" => vec![0.into(), 0.into(), 1.into(), 1.into()],
    });
    let page_id = first_page_id(&document);
    document
      .get_dictionary_mut(page_id)
      .unwrap()
      .set("Annots", vec![Object::Reference(annotation_id)]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();

    let error = inspect_pdf(&bytes).unwrap_err();

    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn deduplicates_file_spec_and_payload_reached_through_names_and_af() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let (file_spec_id, _) = add_untyped_attachment(&mut document);
    set_embedded_file_name_tree(&mut document, file_spec_id);
    document
      .catalog_mut()
      .unwrap()
      .set("AF", vec![Object::Reference(file_spec_id)]);

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_unreferenced_typed_embedded_file_stream() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut stream = lopdf::Stream::new(Dictionary::new(), Vec::new());
    stream
      .dict
      .set("Type", Object::Name(b"EmbeddedFile".to_vec()));
    document.add_object(Object::Stream(stream));

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.embedded_file_count, 1);
  }

  #[test]
  fn inventories_unreferenced_form_xobjects_and_untyped_actions() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    document.add_object(Object::Stream(lopdf::Stream::new(
      lopdf::dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
      },
      b"retained form content".to_vec(),
    )));
    document.add_object(lopdf::dictionary! {
      "S" => "JavaScript",
      "JS" => Object::string_literal("retained script content"),
    });

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.form_x_object_count, 1);
    assert_eq!(inspection.risks.javascript_action_count, 1);
  }

  #[test]
  fn deduplicates_shared_referenced_actions_and_the_object_wide_scan() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let action_id = document.add_object(lopdf::dictionary! {
      "Type" => "Action",
      "S" => "JavaScript",
      "JS" => Object::string_literal("one retained script"),
    });
    document
      .catalog_mut()
      .unwrap()
      .set("OpenAction", Object::Reference(action_id));
    document.catalog_mut().unwrap().set(
      "AA",
      Object::Dictionary(lopdf::dictionary! {
        "WC" => Object::Reference(action_id),
      }),
    );

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.javascript_action_count, 1);
  }

  #[test]
  fn inventories_arbitrary_inline_actions_without_recounting_known_owners() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    document.catalog_mut().unwrap().set(
      "OpenAction",
      Object::Dictionary(lopdf::dictionary! {
        "S" => "JavaScript",
        "JS" => Object::string_literal("one inline script"),
      }),
    );
    document.add_object(lopdf::dictionary! {
      "Payload" => Object::Dictionary(lopdf::dictionary! {
        "S" => "URI",
        "URI" => Object::string_literal("https://example.invalid"),
      }),
    });

    let inspection = inspect_document(&mut document);

    assert_eq!(inspection.risks.javascript_action_count, 1);
    assert_eq!(inspection.risks.external_action_count, 1);
  }

  #[test]
  fn rejects_malformed_attachment_ef_references_and_stream_types() {
    for malformed_payload in [
      Object::Dictionary(Dictionary::new()),
      Object::Stream({
        let mut stream = lopdf::Stream::new(Dictionary::new(), Vec::new());
        stream.dict.set("Type", Object::Name(b"Metadata".to_vec()));
        stream
      }),
    ] {
      let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
      let payload_id = document.add_object(malformed_payload);
      let mut embedded_files = Dictionary::new();
      embedded_files.set("F", Object::Reference(payload_id));
      let mut file_spec = Dictionary::new();
      file_spec.set("EF", Object::Dictionary(embedded_files));
      let file_spec_id = document.add_object(Object::Dictionary(file_spec));
      document
        .catalog_mut()
        .unwrap()
        .set("AF", vec![Object::Reference(file_spec_id)]);
      let mut bytes = Vec::new();
      document.save_to(&mut bytes).unwrap();

      let error = inspect_pdf(&bytes).unwrap_err();

      assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
    }
  }

  #[test]
  fn rejects_unresolved_attachment_payload_references() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let mut embedded_files = Dictionary::new();
    embedded_files.set("F", Object::Reference((999_999, 0)));
    let mut file_spec = Dictionary::new();
    file_spec.set("EF", Object::Dictionary(embedded_files));
    let file_spec_id = document.add_object(Object::Dictionary(file_spec));
    document
      .catalog_mut()
      .unwrap()
      .set("AF", vec![Object::Reference(file_spec_id)]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();

    let error = inspect_pdf(&bytes).unwrap_err();

    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn rejects_cycles_in_embedded_file_name_trees() {
    let mut document = Document::load_mem(MINIMAL_PDF).unwrap();
    let tree_id = document.add_object(Object::Dictionary(Dictionary::new()));
    document
      .get_dictionary_mut(tree_id)
      .unwrap()
      .set("Kids", vec![Object::Reference(tree_id)]);
    let mut names = Dictionary::new();
    names.set("EmbeddedFiles", Object::Reference(tree_id));
    document
      .catalog_mut()
      .unwrap()
      .set("Names", Object::Dictionary(names));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();

    let error = inspect_pdf(&bytes).unwrap_err();

    assert_eq!(error.code(), PdfInspectionErrorCode::InvalidDocument);
  }

  #[test]
  fn inventories_structures_that_can_retain_sensitive_content() {
    let inspection = inspect_pdf(RISKY_PDF).unwrap();
    assert!(inspection.risks.acro_form_field_count >= 1);
    assert!(inspection.risks.annotation_count >= 2);
    assert!(inspection.risks.embedded_file_count >= 1);
    assert!(inspection.risks.document_info_entry_count >= 3);
    assert!(inspection.risks.external_action_count >= 1);
    assert!(inspection.risks.form_x_object_count >= 1);
    assert!(inspection.risks.image_object_count >= 1);
    assert!(inspection.risks.javascript_action_count >= 1);
    assert!(inspection.risks.metadata_stream_count >= 1);
    assert!(inspection.risks.optional_content_group_count >= 1);
    assert!(inspection.risks.signature_count >= 1);
    assert!(inspection.risks.xfa_entry_count >= 1);
  }
}
