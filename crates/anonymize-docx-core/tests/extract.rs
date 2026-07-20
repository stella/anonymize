use std::{
  fmt::Write as _,
  io::{Cursor, Write as _},
};

use stella_anonymize_docx_core::{
  DocxCoverageItem, DocxErrorCode, DocxInlineContext, DocxPartType,
  extract_docx_text,
};
use zip::{ZipWriter, write::SimpleFileOptions};

const CONTENT_TYPES_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIPS_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn docx(
  parts: &[(&str, &str, &str)],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let output = Cursor::new(Vec::new());
  let mut archive = ZipWriter::new(output);
  let options = SimpleFileOptions::default();
  let mut overrides = String::new();
  for (path, content_type, _) in parts {
    write!(
      &mut overrides,
      "<Override PartName=\"/{path}\" ContentType=\"{content_type}\"/>"
    )?;
  }
  archive.start_file("[Content_Types].xml", options)?;
  archive.write_all(
    format!("<Types xmlns=\"{CONTENT_TYPES_NAMESPACE}\">{overrides}</Types>")
      .as_bytes(),
  )?;
  archive.start_file("_rels/.rels", options)?;
  archive.write_all(
    format!(
      "<Relationships xmlns=\"{PACKAGE_RELATIONSHIPS_NAMESPACE}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
    )
    .as_bytes(),
  )?;
  for (path, _, xml) in parts {
    archive.start_file(*path, options)?;
    archive.write_all(xml.as_bytes())?;
  }
  Ok(archive.finish()?.into_inner())
}

#[test]
fn extracts_structural_blocks_and_utf16_segments()
-> Result<(), Box<dyn std::error::Error>> {
  let document_xml = format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\" xmlns:r=\"{OFFICE_RELATIONSHIPS_NAMESPACE}\" xmlns:ext=\"urn:example:extension\"><w:body><w:p><w:r><w:t>😀 </w:t></w:r><w:hyperlink r:id=\"rId5\" ext:anchor=\"not-a-bookmark\" w:anchor=\"bookmark\"><w:r><w:t>Alice</w:t></w:r></w:hyperlink><w:ins><w:r><w:t> added</w:t></w:r></w:ins><w:r><w:tab/><w:br/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p></w:body></w:document>"
  );
  let archive = docx(&[(
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    &document_xml,
  )])?;
  let extraction = extract_docx_text(&archive)?;
  assert_eq!(
    extraction
      .blocks
      .iter()
      .map(|block| block.text.as_str())
      .collect::<Vec<_>>(),
    vec!["😀 Alice added\t\n", "Cell", "", "Box"]
  );
  let first = extraction.blocks.first().ok_or("missing first block")?;
  assert_eq!(
    first.segments.first().ok_or("missing first segment")?.end,
    3
  );
  assert!(matches!(
    first
      .segments
      .get(1)
      .and_then(|segment| segment.contexts.first()),
    Some(DocxInlineContext::Hyperlink {
      relationship_id: Some(relationship_id),
      anchor: Some(anchor),
    }) if relationship_id == "rId5" && anchor == "bookmark"
  ));
  assert_eq!(extraction.coverage.hyperlink_text_segment_count, 1);
  assert_eq!(extraction.coverage.revision_text_segment_count, 1);
  assert!(matches!(
    extraction.coverage.parts.first(),
    Some(DocxCoverageItem::Extracted { part, block_count: 4 })
      if part.part_type == DocxPartType::MainDocument
  ));
  let value = serde_json::to_value(extraction)?;
  assert_eq!(value.get("contractVersion"), Some(&serde_json::json!(1)));
  let segment_start = value
    .get("blocks")
    .and_then(|value| value.as_array())
    .and_then(|blocks| blocks.first())
    .and_then(|block| block.get("segments"))
    .and_then(|value| value.as_array())
    .and_then(|segments| segments.get(1))
    .and_then(|segment| segment.get("start"));
  assert_eq!(segment_start, Some(&serde_json::json!(3)));
  Ok(())
}

#[test]
fn rejects_unsafe_or_incomplete_packages()
-> Result<(), Box<dyn std::error::Error>> {
  let empty = docx(&[])?;
  let error = extract_docx_text(&empty)
    .err()
    .ok_or("expected package error")?;
  assert_eq!(error.code(), DocxErrorCode::InvalidPackage);

  let output = Cursor::new(Vec::new());
  let mut archive = ZipWriter::new(output);
  archive.start_file("../word/document.xml", SimpleFileOptions::default())?;
  archive.write_all(b"unsafe")?;
  let unsafe_archive = archive.finish()?.into_inner();
  let unsafe_error = extract_docx_text(&unsafe_archive)
    .err()
    .ok_or("expected unsafe path error")?;
  assert_eq!(unsafe_error.code(), DocxErrorCode::UnsafeEntryPath);

  let mut duplicate_archive = docx(&[
    (
      "word/documen2.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      "<document/>",
    ),
    (
      "word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      "<document/>",
    ),
  ])?;
  let old_name = b"word/documen2.xml";
  let new_name = b"word/document.xml";
  let name_offsets = duplicate_archive
    .windows(old_name.len())
    .enumerate()
    .filter_map(|(offset, value)| (value == old_name).then_some(offset))
    .collect::<Vec<_>>();
  for offset in name_offsets {
    duplicate_archive
      .get_mut(offset..offset + new_name.len())
      .ok_or("missing duplicate filename bytes")?
      .copy_from_slice(new_name);
  }
  let duplicate_error = extract_docx_text(&duplicate_archive)
    .err()
    .ok_or("expected duplicate path error")?;
  assert_eq!(duplicate_error.code(), DocxErrorCode::InvalidPackage);
  Ok(())
}

#[test]
fn inventories_non_opc_rels_payloads_as_unsupported()
-> Result<(), Box<dyn std::error::Error>> {
  let document_xml = format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:body></w:document>"
  );
  let archive = docx(&[
    (
      "word/document.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      &document_xml,
    ),
    (
      "extra/secrets.rels",
      "application/vnd.openxmlformats-package.relationships+xml",
      "<payload>alice@example.test</payload>",
    ),
    (
      "word/_rels/nested/secrets.rels",
      "application/vnd.openxmlformats-package.relationships+xml",
      "<payload>bob@example.test</payload>",
    ),
    (
      "_rels/custom.xml.rels",
      "application/vnd.openxmlformats-package.relationships+xml",
      "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rIdExternal\" TargetMode=\"External\" Target=\"mailto:carol@example.test\"/></Relationships>",
    ),
  ])?;
  let extraction = extract_docx_text(&archive)?;
  assert!(extraction.coverage.parts.iter().any(|item| matches!(
    item,
    DocxCoverageItem::Unsupported { path, .. }
      if path == "extra/secrets.rels"
  )));
  assert!(extraction.coverage.parts.iter().any(|item| matches!(
    item,
    DocxCoverageItem::Unsupported { path, reason, .. }
      if path == "_rels/custom.xml.rels" && reason.contains("mailto/tel")
  )));
  assert!(extraction.coverage.parts.iter().any(|item| matches!(
    item,
    DocxCoverageItem::Unsupported { path, .. }
      if path == "word/_rels/nested/secrets.rels"
  )));
  Ok(())
}

#[test]
fn extracts_many_sibling_runs_with_stable_paths()
-> Result<(), Box<dyn std::error::Error>> {
  let mut runs = String::new();
  for index in 0..2_000 {
    write!(&mut runs, "<w:r><w:t>{index}</w:t></w:r>")?;
  }
  let document_xml = format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p>{runs}</w:p></w:body></w:document>"
  );
  let archive = docx(&[(
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    &document_xml,
  )])?;
  let extraction = extract_docx_text(&archive)?;
  let block = extraction.blocks.first().ok_or("missing block")?;
  assert_eq!(block.segments.len(), 2_000);
  assert_ne!(
    block
      .segments
      .first()
      .ok_or("missing first segment")?
      .xml_path,
    block
      .segments
      .last()
      .ok_or("missing last segment")?
      .xml_path,
  );
  Ok(())
}

#[test]
fn counts_only_markup_compatibility_alternate_content()
-> Result<(), Box<dyn std::error::Error>> {
  let document_xml = format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:x=\"urn:extension\"><w:body><w:p><w:r><w:t>Alice</w:t></w:r></w:p><mc:AlternateContent/><x:AlternateContent/></w:body></w:document>"
  );
  let archive = docx(&[(
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    &document_xml,
  )])?;
  assert_eq!(
    extract_docx_text(&archive)?
      .coverage
      .unsupported_alternate_content_count,
    1,
  );
  Ok(())
}
