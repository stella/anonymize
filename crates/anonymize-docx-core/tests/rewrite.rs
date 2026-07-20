use std::io::{Cursor, Read as _, Write as _};

use stella_anonymize_docx_core::{
  DocxBlockRewrite, DocxRewriteErrorCode, DocxTextReplacement,
  extract_docx_text, rewrite_docx_text,
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const CONTENT_TYPES_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIPS_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn docx(document_xml: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let output = Cursor::new(Vec::new());
  let mut archive = ZipWriter::new(output);
  let options = SimpleFileOptions::default();
  archive.start_file("[Content_Types].xml", options)?;
  archive.write_all(
    format!(
      "<Types xmlns=\"{CONTENT_TYPES_NAMESPACE}\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"
    )
    .as_bytes(),
  )?;
  archive.start_file("_rels/.rels", options)?;
  archive.write_all(
    format!(
      "<Relationships xmlns=\"{PACKAGE_RELATIONSHIPS_NAMESPACE}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
    )
    .as_bytes(),
  )?;
  archive.start_file("word/document.xml", options)?;
  archive.write_all(document_xml.as_bytes())?;
  archive.start_file("word/unchanged.bin", options)?;
  archive.write_all(b"untouched")?;
  Ok(archive.finish()?.into_inner())
}

fn part(
  document: &[u8],
  path: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut archive = ZipArchive::new(Cursor::new(document))?;
  let mut file = archive.by_name(path)?;
  let mut bytes = Vec::new();
  file.read_to_end(&mut bytes)?;
  Ok(bytes)
}

#[test]
fn rewrites_across_runs_and_preserves_untouched_parts()
-> Result<(), Box<dyn std::error::Error>> {
  let source = docx(&format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p><w:r><w:t xml:space=\"default\">😀 Alice</w:t></w:r><w:r><w:t> Smith</w:t></w:r></w:p></w:body></w:document>"
  ))?;
  let extraction = extract_docx_text(&source)?;
  let block = extraction.blocks.first().ok_or("missing block")?;
  let result = rewrite_docx_text(
    &source,
    &[DocxBlockRewrite {
      location: block.location.clone(),
      expected_text: block.text.clone(),
      replacements: vec![DocxTextReplacement {
        start: 3,
        end: 14,
        replacement: " & Bob ".to_owned(),
      }],
    }],
  )?;
  assert_eq!(part(&result.document, "word/unchanged.bin")?, b"untouched");
  assert_eq!(
    extract_docx_text(&result.document)?
      .blocks
      .first()
      .ok_or("missing rewritten block")?
      .text,
    "😀  & Bob "
  );
  let xml = String::from_utf8(part(&result.document, "word/document.xml")?)?;
  assert!(xml.contains("&amp; Bob"));
  assert!(xml.contains("xml:space=\"preserve\""));
  assert!(!xml.contains("xml:space=\"default\""));
  assert_eq!(xml.matches("xml:space=").count(), 1);
  assert_eq!(result.rewritten_block_count, 1);
  assert_eq!(result.applied_replacement_count, 1);
  Ok(())
}

#[test]
fn preserves_greater_than_characters_inside_text_node_attributes()
-> Result<(), Box<dyn std::error::Error>> {
  let source = docx(&format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\" xmlns:x=\"urn:test\"><w:body><w:p><w:r><w:t x:condition=\"left > right\">Alice</w:t></w:r></w:p></w:body></w:document>"
  ))?;
  let extraction = extract_docx_text(&source)?;
  let block = extraction.blocks.first().ok_or("missing block")?;
  let result = rewrite_docx_text(
    &source,
    &[DocxBlockRewrite {
      location: block.location.clone(),
      expected_text: block.text.clone(),
      replacements: vec![DocxTextReplacement {
        start: 0,
        end: 5,
        replacement: "Bob".to_owned(),
      }],
    }],
  )?;
  let xml = String::from_utf8(part(&result.document, "word/document.xml")?)?;
  assert!(xml.contains("x:condition=\"left > right\">Bob</w:t>"));
  Ok(())
}

#[test]
fn rejects_stale_revision_and_surrogate_splitting_plans()
-> Result<(), Box<dyn std::error::Error>> {
  let source = docx(&format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p><w:r><w:t>😀</w:t></w:r><w:ins><w:r><w:t>Alice</w:t></w:r></w:ins></w:p></w:body></w:document>"
  ))?;
  let extraction = extract_docx_text(&source)?;
  let block = extraction.blocks.first().ok_or("missing block")?;
  for (expected_text, start, end, expected_code) in [
    ("changed", 2, 7, DocxRewriteErrorCode::StaleExtraction),
    (
      "😀Alice",
      2,
      7,
      DocxRewriteErrorCode::UnsupportedReplacement,
    ),
    ("😀Alice", 1, 2, DocxRewriteErrorCode::InvalidReplacement),
  ] {
    let error = rewrite_docx_text(
      &source,
      &[DocxBlockRewrite {
        location: block.location.clone(),
        expected_text: expected_text.to_owned(),
        replacements: vec![DocxTextReplacement {
          start,
          end,
          replacement: "X".to_owned(),
        }],
      }],
    )
    .err()
    .ok_or("expected rewrite error")?;
    assert_eq!(error.code(), expected_code);
  }
  Ok(())
}

#[test]
fn empty_plan_returns_an_exact_copy() -> Result<(), Box<dyn std::error::Error>>
{
  let source = docx(&format!(
    "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:body></w:document>"
  ))?;
  let result = rewrite_docx_text(&source, &[])?;
  assert_eq!(result.document, source);
  Ok(())
}

#[test]
fn preserves_extraction_errors_before_rewriting()
-> Result<(), Box<dyn std::error::Error>> {
  let error = rewrite_docx_text(b"not a DOCX archive", &[])
    .err()
    .ok_or("expected invalid archive error")?;
  assert_eq!(error.code(), DocxRewriteErrorCode::InvalidArchive);
  Ok(())
}
