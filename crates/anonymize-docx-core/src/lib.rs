#![forbid(unsafe_code)]

use std::{
  collections::{HashMap, HashSet},
  io::{Cursor, Read},
  path::Path,
};

use percent_encoding::percent_decode_str;
use roxmltree::{Document, Node, NodeId};
use serde::Serialize;
use thiserror::Error;
use zip::ZipArchive;

pub const DOCX_EXTRACTION_CONTRACT_VERSION: u8 = 1;
pub const DOCX_ARCHIVE_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const DOCX_ENTRY_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const DOCX_UNCOMPRESSED_MAX_BYTES: usize = 128 * 1024 * 1024;
pub const DOCX_XML_MAX_DEPTH: usize = 256;
const DOCX_MAX_ENTRIES: usize = 4_096;
const DOCX_MAX_TEXT_BLOCKS: usize = 100_000;
const DOCX_MAX_TEXT_SEGMENTS: usize = 1_000_000;
const DOCX_MAX_INLINE_CONTEXT_SCAN_OPS: usize = 20_000_000;

const CONTENT_TYPES_PATH: &str = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PATH: &str = "_rels/.rels";
const CONTENT_TYPES_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-package.relationships+xml";
const WORDPROCESSING_CONTENT_TYPE_PREFIX: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const GENERIC_XML_CONTENT_TYPE: &str = "application/xml";
const GENERIC_BINARY_CONTENT_TYPE: &str = "application/octet-stream";
const CORE_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-package.core-properties+xml";
const EXTENDED_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";
const CUSTOM_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const WORDPROCESSING_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
];
const RELATIONSHIP_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
];
const PACKAGE_RELATIONSHIP_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/package/relationships",
  "http://schemas.openxmlformats.org/package/2006/relationships",
];
const MARKUP_COMPATIBILITY_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/markup-compatibility/main",
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
];

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct DocxError {
  code: DocxErrorCode,
  message: String,
}

impl DocxError {
  #[must_use]
  pub const fn code(&self) -> DocxErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DocxErrorCode {
  ArchiveLimitExceeded,
  InvalidArchive,
  InvalidPackage,
  InvalidXml,
  UnsafeEntryPath,
  UncompressedLimitExceeded,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxPartType {
  Comments,
  Endnotes,
  Footer,
  Footnotes,
  Header,
  MainDocument,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxPart {
  #[serde(rename = "type")]
  pub part_type: DocxPartType,
  pub path: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DocxBlockLocation {
  Paragraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
  },
  TableCellParagraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
    #[serde(rename = "tablePath")]
    table_path: Vec<usize>,
    #[serde(rename = "rowPath")]
    row_path: Vec<usize>,
    #[serde(rename = "cellPath")]
    cell_path: Vec<usize>,
  },
  TextBoxParagraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
    #[serde(rename = "textBoxPath")]
    text_box_path: Vec<usize>,
  },
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DocxInlineContext {
  Hyperlink {
    #[serde(rename = "relationshipId")]
    relationship_id: Option<String>,
    anchor: Option<String>,
  },
  Revision {
    revision: DocxRevision,
  },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxRevision {
  Deletion,
  Insertion,
  MoveFrom,
  MoveTo,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxSegmentSource {
  Break,
  Tab,
  Text,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxTextSegment {
  pub start: usize,
  pub end: usize,
  pub source: DocxSegmentSource,
  pub contexts: Vec<DocxInlineContext>,
  #[serde(rename = "xmlPath")]
  pub xml_path: Vec<usize>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxTextBlock {
  pub text: String,
  pub location: DocxBlockLocation,
  pub segments: Vec<DocxTextSegment>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum DocxCoverageItem {
  Extracted {
    part: DocxPart,
    #[serde(rename = "blockCount")]
    block_count: usize,
  },
  Unsupported {
    path: String,
    #[serde(rename = "contentType")]
    content_type: String,
    reason: String,
  },
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Default)]
pub struct DocxCoverage {
  pub parts: Vec<DocxCoverageItem>,
  #[serde(rename = "hyperlinkTextSegmentCount")]
  pub hyperlink_text_segment_count: usize,
  #[serde(rename = "revisionTextSegmentCount")]
  pub revision_text_segment_count: usize,
  #[serde(rename = "unsupportedAlternateContentCount")]
  pub unsupported_alternate_content_count: usize,
  #[serde(rename = "unsupportedSymbolCount")]
  pub unsupported_symbol_count: usize,
  #[serde(rename = "unsupportedFieldInstructionCount")]
  pub unsupported_field_instruction_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxExtraction {
  #[serde(rename = "contractVersion")]
  pub contract_version: u8,
  pub blocks: Vec<DocxTextBlock>,
  pub coverage: DocxCoverage,
}

#[derive(Debug)]
struct ArchiveEntry {
  path: String,
  bytes: Vec<u8>,
}

#[derive(Debug)]
struct ContentTypePart {
  path: String,
  content_type: String,
}

fn error(code: DocxErrorCode, message: impl Into<String>) -> DocxError {
  DocxError {
    code,
    message: message.into(),
  }
}

fn safe_entry_path(path: &str) -> bool {
  !path.is_empty()
    && !path.starts_with('/')
    && !path.contains('\\')
    && !path.contains('\0')
    && !path.split('/').any(|part| part == "..")
}

fn checked_uncompressed_total(
  total: u64,
  additional: u64,
) -> Result<u64, DocxError> {
  let next = total.checked_add(additional).ok_or_else(|| {
    error(
      DocxErrorCode::UncompressedLimitExceeded,
      "DOCX uncompressed byte count overflowed",
    )
  })?;
  if next > u64::try_from(DOCX_UNCOMPRESSED_MAX_BYTES).unwrap_or(u64::MAX) {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes"
      ),
    ));
  }
  Ok(next)
}

fn read_archive(document: &[u8]) -> Result<Vec<ArchiveEntry>, DocxError> {
  if document.len() > DOCX_ARCHIVE_MAX_BYTES {
    return Err(error(
      DocxErrorCode::ArchiveLimitExceeded,
      format!("DOCX archives must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes"),
    ));
  }
  let mut archive = ZipArchive::new(Cursor::new(document)).map_err(|_| {
    error(
      DocxErrorCode::InvalidArchive,
      "Input is not a valid bounded DOCX ZIP archive",
    )
  })?;
  if archive.len() > DOCX_MAX_ENTRIES {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!("DOCX archives must contain at most {DOCX_MAX_ENTRIES} entries"),
    ));
  }
  let mut entries = Vec::with_capacity(archive.len());
  let mut seen_paths = HashSet::with_capacity(archive.len());
  let mut total = 0_u64;
  for index in 0..archive.len() {
    let file = archive.by_index(index).map_err(|_| {
      error(
        DocxErrorCode::InvalidArchive,
        "Input is not a valid bounded DOCX ZIP archive",
      )
    })?;
    let path = file.name().to_owned();
    if !safe_entry_path(&path) {
      return Err(error(
        DocxErrorCode::UnsafeEntryPath,
        "DOCX archive contains an unsafe entry path",
      ));
    }
    if !seen_paths.insert(path.clone()) {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        format!("DOCX archive contains a duplicate entry path: {path}"),
      ));
    }
    let entry_limit = u64::try_from(DOCX_ENTRY_MAX_BYTES).unwrap_or(u64::MAX);
    if file.size() > entry_limit {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!("DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes"),
      ));
    }
    checked_uncompressed_total(total, file.size())?;
    let capacity = usize::try_from(file.size()).map_err(|_| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX entry size is unavailable",
      )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    file
      .take(entry_limit.saturating_add(1))
      .read_to_end(&mut bytes)
      .map_err(|_| {
        error(
          DocxErrorCode::InvalidArchive,
          "Input is not a valid bounded DOCX ZIP archive",
        )
      })?;
    if bytes.len() > DOCX_ENTRY_MAX_BYTES {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!("DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes"),
      ));
    }
    total = checked_uncompressed_total(
      total,
      u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    )?;
    entries.push(ArchiveEntry { path, bytes });
  }
  Ok(entries)
}

fn parse_xml<'a>(
  bytes: &'a [u8],
  path: &str,
) -> Result<Document<'a>, DocxError> {
  let text = std::str::from_utf8(bytes).map_err(|_| {
    error(
      DocxErrorCode::InvalidXml,
      format!("DOCX XML part is not valid UTF-8: {path}"),
    )
  })?;
  if bytes
    .windows(b"<!DOCTYPE".len())
    .any(|window| window.eq_ignore_ascii_case(b"<!DOCTYPE"))
  {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX XML must not contain a document type declaration",
    ));
  }
  let document = Document::parse(text).map_err(|_| {
    error(
      DocxErrorCode::InvalidXml,
      format!("DOCX part is not valid XML: {path}"),
    )
  })?;
  let mut depths = HashMap::<NodeId, usize>::new();
  for node in document.descendants().filter(Node::is_element) {
    let parent_depth = node
      .parent_element()
      .and_then(|parent| depths.get(&parent.id()))
      .copied()
      .unwrap_or_default();
    let depth = parent_depth.saturating_add(1);
    if depth >= DOCX_XML_MAX_DEPTH {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!(
          "DOCX XML must not exceed {DOCX_XML_MAX_DEPTH} nested elements"
        ),
      ));
    }
    depths.insert(node.id(), depth);
  }
  Ok(document)
}

fn attribute(node: Node<'_, '_>, local: &str) -> Option<String> {
  node
    .attributes()
    .find(|attribute| attribute.name() == local)
    .map(|attribute| attribute.value().to_owned())
}

fn parse_content_types(
  bytes: &[u8],
) -> Result<Vec<ContentTypePart>, DocxError> {
  let document = parse_xml(bytes, CONTENT_TYPES_PATH)?;
  let mut parts = Vec::new();
  let mut paths = HashSet::new();
  for node in document.descendants().filter(Node::is_element) {
    if node.tag_name().name() != "Override"
      || node.tag_name().namespace() != Some(CONTENT_TYPES_NAMESPACE)
    {
      continue;
    }
    let raw_path = attribute(node, "PartName").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type override is incomplete",
      )
    })?;
    let content_type = attribute(node, "ContentType").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type override is incomplete",
      )
    })?;
    let path = raw_path.strip_prefix('/').unwrap_or(&raw_path).to_owned();
    if !safe_entry_path(&path) || !paths.insert(path.clone()) {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type overrides must have unique safe paths",
      ));
    }
    parts.push(ContentTypePart { path, content_type });
  }
  Ok(parts)
}

fn parse_main_target(bytes: &[u8]) -> Result<String, DocxError> {
  let document = parse_xml(bytes, ROOT_RELATIONSHIPS_PATH)?;
  let allowed = RELATIONSHIP_NAMESPACES
    .map(|namespace| format!("{namespace}/officeDocument"));
  let mut targets = Vec::new();
  for node in document.descendants().filter(Node::is_element) {
    if node.tag_name().name() != "Relationship"
      || !PACKAGE_RELATIONSHIP_NAMESPACES
        .contains(&node.tag_name().namespace().unwrap_or_default())
      || !attribute(node, "Type").is_some_and(|value| allowed.contains(&value))
    {
      continue;
    }
    let target = attribute(node, "Target").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship must be internal",
      )
    })?;
    if attribute(node, "TargetMode").is_some_and(|value| value == "External") {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship must be internal",
      ));
    }
    let normalized = target.strip_prefix('/').unwrap_or(&target).to_owned();
    if !safe_entry_path(&normalized) || normalized.contains(':') {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship has an unsafe target",
      ));
    }
    targets.push(normalized);
  }
  if targets.len() != 1 {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX archive must contain exactly one main-document relationship",
    ));
  }
  targets.into_iter().next().ok_or_else(|| {
    error(
      DocxErrorCode::InvalidPackage,
      "DOCX main-document relationship is unavailable",
    )
  })
}

fn classify_part(part: &ContentTypePart) -> Option<DocxPart> {
  let suffix = part
    .content_type
    .strip_prefix(WORDPROCESSING_CONTENT_TYPE_PREFIX)?;
  let part_type = match suffix {
    "comments+xml" => DocxPartType::Comments,
    "document.main+xml" => DocxPartType::MainDocument,
    "endnotes+xml" => DocxPartType::Endnotes,
    "footer+xml" => DocxPartType::Footer,
    "footnotes+xml" => DocxPartType::Footnotes,
    "header+xml" => DocxPartType::Header,
    _ => return None,
  };
  Some(DocxPart {
    part_type,
    path: part.path.clone(),
  })
}

fn validate_main_part(
  supported: &[DocxPart],
  main_target: &str,
) -> Result<(), DocxError> {
  let main_parts = supported
    .iter()
    .filter(|part| part.part_type == DocxPartType::MainDocument)
    .collect::<Vec<_>>();
  if main_parts.len() != 1 {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX archive must contain exactly one main document",
    ));
  }
  if main_parts
    .first()
    .is_none_or(|part| part.path != main_target)
  {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX main-document relationship and content type do not agree",
    ));
  }
  Ok(())
}

fn is_word(node: Node<'_, '_>, local: &str) -> bool {
  node.tag_name().name() == local
    && WORDPROCESSING_NAMESPACES
      .contains(&node.tag_name().namespace().unwrap_or_default())
}

fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

fn add_count(target: &mut usize, amount: usize) -> Result<(), DocxError> {
  *target = target.checked_add(amount).ok_or_else(|| {
    error(
      DocxErrorCode::UncompressedLimitExceeded,
      "DOCX coverage count overflowed",
    )
  })?;
  Ok(())
}

fn has_extension(path: &str, extension: &str) -> bool {
  Path::new(path)
    .extension()
    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn is_metadata_content_type(content_type: &str) -> bool {
  matches!(
    content_type,
    CORE_PROPERTIES_CONTENT_TYPE
      | EXTENDED_PROPERTIES_CONTENT_TYPE
      | CUSTOM_PROPERTIES_CONTENT_TYPE
  )
}

fn known_metadata_content_type(path: &str) -> Option<&'static str> {
  match path {
    "docProps/core.xml" => Some(CORE_PROPERTIES_CONTENT_TYPE),
    "docProps/app.xml" => Some(EXTENDED_PROPERTIES_CONTENT_TYPE),
    "docProps/custom.xml" => Some(CUSTOM_PROPERTIES_CONTENT_TYPE),
    _ => None,
  }
}

fn is_relationships_entry(path: &str) -> bool {
  if path == ROOT_RELATIONSHIPS_PATH {
    return true;
  }
  path
    .strip_prefix("_rels/")
    .or_else(|| path.rsplit_once("/_rels/").map(|(_, filename)| filename))
    .is_some_and(|filename| {
      !filename.contains('/') && has_extension(filename, "rels")
    })
}

fn has_uri_scheme(target: &str) -> bool {
  let mut characters = target.chars();
  if !characters
    .next()
    .is_some_and(|value| value.is_ascii_alphabetic())
  {
    return false;
  }
  characters.take_while(|value| *value != ':').all(|value| {
    value.is_ascii_alphanumeric() || matches!(value, '+' | '.' | '-')
  }) && target.contains(':')
}

fn normalize_package_path(path: &str) -> Option<String> {
  let mut normalized = Vec::new();
  for segment in path.split('/') {
    match segment {
      "" | "." => {}
      ".." => {
        normalized.pop()?;
      }
      value => normalized.push(value),
    }
  }
  (!normalized.is_empty()).then(|| normalized.join("/"))
}

fn resolve_relationship_target(
  target: &str,
  relationships_path: &str,
) -> Option<String> {
  let decoded = percent_decode_str(target.trim()).decode_utf8().ok()?;
  if decoded.starts_with('/') {
    return normalize_package_path(decoded.trim_start_matches('/'));
  }
  let base = relationships_path
    .rfind("_rels/")
    .and_then(|index| relationships_path.get(..index))
    .unwrap_or_default();
  normalize_package_path(&format!("{base}{decoded}"))
}

fn relationship_coverage(
  entries: &[ArchiveEntry],
) -> Result<Vec<DocxCoverageItem>, DocxError> {
  let known_paths = entries
    .iter()
    .map(|entry| entry.path.to_ascii_lowercase())
    .collect::<HashSet<_>>();
  let mut coverage = Vec::new();
  for entry in entries
    .iter()
    .filter(|entry| is_relationships_entry(&entry.path))
  {
    let document = parse_xml(&entry.bytes, &entry.path)?;
    for node in document.descendants().filter(Node::is_element) {
      if node.tag_name().name() != "Relationship"
        || !PACKAGE_RELATIONSHIP_NAMESPACES
          .contains(&node.tag_name().namespace().unwrap_or_default())
      {
        continue;
      }
      let Some(target) = attribute(node, "Target") else {
        continue;
      };
      let trimmed = target.trim();
      let external = attribute(node, "TargetMode")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("external"))
        || has_uri_scheme(trimmed)
        || trimmed.starts_with("//");
      let resolved = (!external)
        .then(|| resolve_relationship_target(trimmed, &entry.path))
        .flatten();
      if !external
        && resolved
          .as_ref()
          .is_some_and(|path| known_paths.contains(&path.to_ascii_lowercase()))
      {
        continue;
      }
      let reason = if trimmed.to_ascii_lowercase().starts_with("mailto:")
        || trimmed.to_ascii_lowercase().starts_with("tel:")
      {
        "target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact"
      } else if external {
        "target is external and is not examined or redacted by anonymization"
      } else {
        "target does not resolve to a package part and is not examined or redacted by anonymization"
      };
      let prefix = attribute(node, "Id").map_or_else(
        || "Relationship".to_owned(),
        |identifier| format!("Relationship \"{identifier}\""),
      );
      coverage.push(DocxCoverageItem::Unsupported {
        path: entry.path.clone(),
        content_type: RELATIONSHIPS_CONTENT_TYPE.to_owned(),
        reason: format!("{prefix} {reason}"),
      });
    }
  }
  Ok(coverage)
}

fn element_child_indices(document: &Document<'_>) -> HashMap<NodeId, usize> {
  let mut indices = HashMap::new();
  indices.insert(document.root_element().id(), 0);
  for parent in document.descendants().filter(Node::is_element) {
    for (index, child) in parent.children().filter(Node::is_element).enumerate()
    {
      indices.insert(child.id(), index);
    }
  }
  indices
}

fn node_path(
  node: Node<'_, '_>,
  child_indices: &HashMap<NodeId, usize>,
) -> Vec<usize> {
  let mut path = Vec::new();
  let mut current = Some(node);
  while let Some(item) = current {
    path.push(child_indices.get(&item.id()).copied().unwrap_or_default());
    current = item.parent_element();
  }
  path.reverse();
  path
}

fn contexts(
  node: Node<'_, '_>,
  inline_context_scan_ops: &mut usize,
) -> Result<Vec<DocxInlineContext>, DocxError> {
  let mut found = Vec::new();
  let mut ancestors = node
    .ancestors()
    .filter(Node::is_element)
    .collect::<Vec<_>>();
  *inline_context_scan_ops = inline_context_scan_ops
    .checked_add(ancestors.len())
    .ok_or_else(|| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX inline-context scan operation count overflowed",
      )
    })?;
  if *inline_context_scan_ops > DOCX_MAX_INLINE_CONTEXT_SCAN_OPS {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not require more than {DOCX_MAX_INLINE_CONTEXT_SCAN_OPS} aggregate inline-context scan operations"
      ),
    ));
  }
  ancestors.reverse();
  for ancestor in ancestors {
    if is_word(ancestor, "hyperlink") {
      let relationship_id = ancestor
        .attributes()
        .find(|attribute| {
          attribute.name() == "id"
            && RELATIONSHIP_NAMESPACES
              .contains(&attribute.namespace().unwrap_or_default())
        })
        .map(|attribute| attribute.value().to_owned());
      found.push(DocxInlineContext::Hyperlink {
        relationship_id,
        anchor: ancestor
          .attributes()
          .find(|attribute| {
            attribute.name() == "anchor"
              && WORDPROCESSING_NAMESPACES
                .contains(&attribute.namespace().unwrap_or_default())
          })
          .map(|attribute| attribute.value().to_owned()),
      });
    }
    let revision = match ancestor.tag_name().name() {
      "del" if is_word(ancestor, "del") => Some(DocxRevision::Deletion),
      "ins" if is_word(ancestor, "ins") => Some(DocxRevision::Insertion),
      "moveFrom" if is_word(ancestor, "moveFrom") => {
        Some(DocxRevision::MoveFrom)
      }
      "moveTo" if is_word(ancestor, "moveTo") => Some(DocxRevision::MoveTo),
      _ => None,
    };
    if let Some(revision) = revision {
      found.push(DocxInlineContext::Revision { revision });
    }
  }
  Ok(found)
}

fn block_location(
  part: &DocxPart,
  paragraph: Node<'_, '_>,
  block_index: usize,
  child_indices: &HashMap<NodeId, usize>,
) -> DocxBlockLocation {
  let xml_path = node_path(paragraph, child_indices);
  if let Some(text_box) = paragraph
    .ancestors()
    .find(|node| is_word(*node, "txbxContent"))
  {
    return DocxBlockLocation::TextBoxParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      text_box_path: node_path(text_box, child_indices),
    };
  }
  let cell = paragraph.ancestors().find(|node| is_word(*node, "tc"));
  let row = paragraph.ancestors().find(|node| is_word(*node, "tr"));
  let table = paragraph.ancestors().find(|node| is_word(*node, "tbl"));
  if let (Some(cell), Some(row), Some(table)) = (cell, row, table) {
    return DocxBlockLocation::TableCellParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      table_path: node_path(table, child_indices),
      row_path: node_path(row, child_indices),
      cell_path: node_path(cell, child_indices),
    };
  }
  DocxBlockLocation::Paragraph {
    part: part.clone(),
    block_index,
    xml_path,
  }
}

fn nearest_paragraph<'tree, 'input>(
  node: Node<'tree, 'input>,
) -> Option<Node<'tree, 'input>> {
  node.ancestors().find(|ancestor| is_word(*ancestor, "p"))
}

#[allow(clippy::too_many_lines)]
fn extract_part(
  part: &DocxPart,
  bytes: &[u8],
  total_segments: &mut usize,
  inline_context_scan_ops: &mut usize,
) -> Result<(Vec<DocxTextBlock>, DocxCoverage), DocxError> {
  let document = parse_xml(bytes, &part.path)?;
  let child_indices = element_child_indices(&document);
  for node in document.descendants().filter(Node::is_element) {
    if (is_word(node, "t") || is_word(node, "delText"))
      && nearest_paragraph(node).is_none()
      && node.text().is_some_and(|text| !text.is_empty())
    {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX text is outside a paragraph",
      ));
    }
  }
  let paragraphs = document
    .descendants()
    .filter(Node::is_element)
    .filter(|node| is_word(*node, "p"))
    .collect::<Vec<_>>();
  if paragraphs.len() > DOCX_MAX_TEXT_BLOCKS {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX parts must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks"
      ),
    ));
  }
  let mut blocks = Vec::with_capacity(paragraphs.len());
  let mut coverage = DocxCoverage::default();
  for (block_index, paragraph) in paragraphs.into_iter().enumerate() {
    let mut text = String::new();
    let mut text_utf16_len = 0_usize;
    let mut segments = Vec::new();
    for node in paragraph.descendants().filter(Node::is_element) {
      if nearest_paragraph(node) != Some(paragraph) {
        continue;
      }
      let (source, value) = if is_word(node, "t") || is_word(node, "delText") {
        let value = node
          .children()
          .filter(Node::is_text)
          .filter_map(|child| child.text())
          .collect::<String>();
        (DocxSegmentSource::Text, value)
      } else if is_word(node, "tab") {
        (DocxSegmentSource::Tab, "\t".to_owned())
      } else if is_word(node, "br") || is_word(node, "cr") {
        (DocxSegmentSource::Break, "\n".to_owned())
      } else {
        continue;
      };
      if value.is_empty() {
        continue;
      }
      *total_segments = total_segments.checked_add(1).ok_or_else(|| {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          "DOCX text segment count overflowed",
        )
      })?;
      if *total_segments > DOCX_MAX_TEXT_SEGMENTS {
        return Err(error(
          DocxErrorCode::UncompressedLimitExceeded,
          format!(
            "DOCX archives must not contain more than {DOCX_MAX_TEXT_SEGMENTS} text segments"
          ),
        ));
      }
      let start = text_utf16_len;
      text_utf16_len = text_utf16_len
        .checked_add(utf16_len(&value))
        .ok_or_else(|| {
          error(
            DocxErrorCode::UncompressedLimitExceeded,
            "DOCX text length overflowed",
          )
        })?;
      text.push_str(&value);
      let item_contexts = contexts(node, inline_context_scan_ops)?;
      if item_contexts
        .iter()
        .any(|item| matches!(item, DocxInlineContext::Hyperlink { .. }))
      {
        add_count(&mut coverage.hyperlink_text_segment_count, 1)?;
      }
      if item_contexts
        .iter()
        .any(|item| matches!(item, DocxInlineContext::Revision { .. }))
      {
        add_count(&mut coverage.revision_text_segment_count, 1)?;
      }
      segments.push(DocxTextSegment {
        start,
        end: text_utf16_len,
        source,
        contexts: item_contexts,
        xml_path: node_path(node, &child_indices),
      });
    }
    blocks.push(DocxTextBlock {
      text,
      location: block_location(part, paragraph, block_index, &child_indices),
      segments,
    });
  }
  coverage.unsupported_symbol_count = document
    .descendants()
    .filter(|node| is_word(*node, "sym"))
    .count();
  coverage.unsupported_field_instruction_count = document
    .descendants()
    .filter(|node| is_word(*node, "instrText") || is_word(*node, "fldSimple"))
    .count();
  coverage.unsupported_alternate_content_count = document
    .descendants()
    .filter(|node| {
      node.tag_name().name() == "AlternateContent"
        && MARKUP_COMPATIBILITY_NAMESPACES
          .contains(&node.tag_name().namespace().unwrap_or_default())
    })
    .count();
  Ok((blocks, coverage))
}

fn add_inventory_coverage<'a>(
  entries: &[ArchiveEntry],
  content_types: &'a [ContentTypePart],
  covered: &mut HashSet<&'a str>,
  coverage: &mut DocxCoverage,
) {
  let overrides = content_types
    .iter()
    .map(|part| (part.path.as_str(), part.content_type.as_str()))
    .collect::<HashMap<_, _>>();
  for part in content_types {
    if covered.contains(part.path.as_str())
      || part.content_type == RELATIONSHIPS_CONTENT_TYPE
    {
      continue;
    }
    let reason = if is_metadata_content_type(&part.content_type) {
      "Document metadata parts are not extracted or redacted"
    } else if part
      .content_type
      .starts_with(WORDPROCESSING_CONTENT_TYPE_PREFIX)
    {
      "WordprocessingML part type is not extracted"
    } else {
      "Package part type is not extracted or redacted"
    };
    coverage.parts.push(DocxCoverageItem::Unsupported {
      path: part.path.clone(),
      content_type: part.content_type.clone(),
      reason: reason.to_owned(),
    });
    covered.insert(part.path.as_str());
  }
  for entry in entries {
    if covered.contains(entry.path.as_str())
      || entry.path.ends_with('/')
      || is_relationships_entry(&entry.path)
    {
      continue;
    }
    let metadata = entry.path.starts_with("docProps/");
    let custom_xml =
      entry.path.starts_with("customXml/") && has_extension(&entry.path, "xml");
    coverage.parts.push(DocxCoverageItem::Unsupported {
      path: entry.path.clone(),
      content_type: overrides.get(entry.path.as_str()).map_or_else(
        || {
          known_metadata_content_type(&entry.path).map_or_else(
            || {
              if has_extension(&entry.path, "xml") {
                GENERIC_XML_CONTENT_TYPE.to_owned()
              } else {
                GENERIC_BINARY_CONTENT_TYPE.to_owned()
              }
            },
            str::to_owned,
          )
        },
        |value| (*value).to_owned(),
      ),
      reason: if metadata {
        "Document metadata parts are not extracted or redacted"
      } else if custom_xml {
        "Custom XML parts are not extracted or redacted"
      } else {
        "Package part is not examined by anonymization"
      }
      .to_owned(),
    });
  }
}

pub fn extract_docx_text(document: &[u8]) -> Result<DocxExtraction, DocxError> {
  let entries = read_archive(document)?;
  let entries_by_path = entries
    .iter()
    .map(|entry| (entry.path.as_str(), entry.bytes.as_slice()))
    .collect::<HashMap<_, _>>();
  let content_type_bytes =
    entries_by_path.get(CONTENT_TYPES_PATH).ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX archive is missing [Content_Types].xml",
      )
    })?;
  let content_types = parse_content_types(content_type_bytes)?;
  let root_relationships = entries_by_path
    .get(ROOT_RELATIONSHIPS_PATH)
    .ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX archive is missing _rels/.rels",
      )
    })?;
  let main_target = parse_main_target(root_relationships)?;
  let supported = content_types
    .iter()
    .filter_map(classify_part)
    .collect::<Vec<_>>();
  validate_main_part(&supported, &main_target)?;
  let mut blocks = Vec::new();
  let mut coverage = DocxCoverage::default();
  let mut total_segments = 0_usize;
  let mut inline_context_scan_ops = 0_usize;
  let mut covered =
    HashSet::from([CONTENT_TYPES_PATH, ROOT_RELATIONSHIPS_PATH]);
  for part in &supported {
    let bytes = entries_by_path.get(part.path.as_str()).ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        format!("DOCX archive is missing declared part: {}", part.path),
      )
    })?;
    let (part_blocks, part_coverage) = extract_part(
      part,
      bytes,
      &mut total_segments,
      &mut inline_context_scan_ops,
    )?;
    if blocks.len().saturating_add(part_blocks.len()) > DOCX_MAX_TEXT_BLOCKS {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!(
          "DOCX archives must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks"
        ),
      ));
    }
    coverage.parts.push(DocxCoverageItem::Extracted {
      part: part.clone(),
      block_count: part_blocks.len(),
    });
    add_count(
      &mut coverage.hyperlink_text_segment_count,
      part_coverage.hyperlink_text_segment_count,
    )?;
    add_count(
      &mut coverage.revision_text_segment_count,
      part_coverage.revision_text_segment_count,
    )?;
    add_count(
      &mut coverage.unsupported_alternate_content_count,
      part_coverage.unsupported_alternate_content_count,
    )?;
    add_count(
      &mut coverage.unsupported_symbol_count,
      part_coverage.unsupported_symbol_count,
    )?;
    add_count(
      &mut coverage.unsupported_field_instruction_count,
      part_coverage.unsupported_field_instruction_count,
    )?;
    blocks.extend(part_blocks);
    covered.insert(part.path.as_str());
  }
  coverage.parts.extend(relationship_coverage(&entries)?);
  add_inventory_coverage(&entries, &content_types, &mut covered, &mut coverage);
  Ok(DocxExtraction {
    contract_version: DOCX_EXTRACTION_CONTRACT_VERSION,
    blocks,
    coverage,
  })
}
