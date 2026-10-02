// The fixtures are written by the LibreOffice "MS Word 2007 XML" filter from
// the `.fodt` sources beside them (`soffice --headless --convert-to
// docx:"MS Word 2007 XML"`). Flat ODT has no font-hint attribute, so the East
// Asian fixture adds `w:hint="eastAsia"` to its run and passes the package
// through the same filter again, which keeps the hint.

use std::io::{Cursor, Read as _};

use stella_anonymize_docx_core::{
  DocxAnonymizedExportPreparation, finalize_docx_anonymized_export,
  prepare_docx_anonymized_export, validate_docx_anonymized_export,
};
use zip::ZipArchive;

const NOTES_BULLETS_GRID: &[u8] =
  include_bytes!("fixtures/word-export/notes-bullets-grid.docx");
const EAST_ASIAN_HINT_GRID: &[u8] =
  include_bytes!("fixtures/word-export/east-asian-hint-grid.docx");

fn part_names(
  document: &[u8],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
  let archive = ZipArchive::new(Cursor::new(document))?;
  let mut names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
  names.sort_unstable();
  Ok(names)
}

fn part(
  document: &[u8],
  path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
  let mut archive = ZipArchive::new(Cursor::new(document))?;
  let mut content = String::new();
  archive.by_name(path)?.read_to_string(&mut content)?;
  Ok(content)
}

fn block_texts(prepared: &DocxAnonymizedExportPreparation) -> Vec<&str> {
  prepared
    .extraction
    .blocks
    .iter()
    .map(|block| block.text.as_str())
    .collect()
}

fn assert_metadata_removed(
  source: &[u8],
  prepared: &DocxAnonymizedExportPreparation,
) -> Result<(), Box<dyn std::error::Error>> {
  assert!(
    part(source, "docProps/core.xml")?.contains("Synthetic Metadata"),
    "the source fixture must carry document metadata"
  );
  for name in part_names(&prepared.document)? {
    assert!(!name.starts_with("docProps/"), "{name} must be removed");
    assert!(
      !part(&prepared.document, &name)?.contains("Synthetic Metadata"),
      "{name} must not carry document metadata"
    );
  }
  Ok(())
}

fn assert_stable_export(
  prepared: &DocxAnonymizedExportPreparation,
) -> Result<(), Box<dyn std::error::Error>> {
  assert_eq!(
    validate_docx_anonymized_export(&prepared.document)?,
    prepared.extraction,
    "validating the export must reproduce its extraction"
  );
  assert_eq!(
    finalize_docx_anonymized_export(&prepared.document)?,
    prepared.document,
    "exporting an exported package must not change it"
  );
  Ok(())
}

#[test]
fn exports_notes_symbol_bullets_and_document_grid()
-> Result<(), Box<dyn std::error::Error>> {
  let prepared = prepare_docx_anonymized_export(NOTES_BULLETS_GRID)?;

  assert_eq!(
    part_names(&prepared.document)?,
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/endnotes.xml",
      "word/footnotes.xml",
      "word/numbering.xml",
      "word/styles.xml",
      "word/theme/theme1.xml",
    ]
  );
  assert_eq!(prepared.report.removed_part_count, 4);
  assert_eq!(prepared.report.sanitized_xml_part_count, 9);
  assert_eq!(
    block_texts(&prepared),
    [
      "Synthetic clause one. Synthetic clause two.",
      "First synthetic item",
      "Second synthetic item",
      "合成テキストの段落です。",
      "",
      "",
      "Synthetic endnote text.",
      "",
      "",
      "Synthetic footnote text.",
    ]
  );

  let document = part(&prepared.document, "word/document.xml")?;
  assert!(document.contains("<w:footnoteReference w:id=\"2\"/>"));
  assert!(document.contains("<w:endnoteReference w:id=\"2\"/>"));
  assert!(document.contains(
    "<w:docGrid w:charSpace=\"24576\" w:linePitch=\"360\" w:type=\"lines\"/>"
  ));
  let footnotes = part(&prepared.document, "word/footnotes.xml")?;
  assert!(footnotes.contains(
    "<w:footnoteRef/></w:r><w:r><w:rPr/><w:t>Synthetic footnote text.</w:t>"
  ));
  let endnotes = part(&prepared.document, "word/endnotes.xml")?;
  assert!(endnotes.contains(
    "<w:endnoteRef/></w:r><w:r><w:rPr/><w:t>Synthetic endnote text.</w:t>"
  ));
  let numbering = part(&prepared.document, "word/numbering.xml")?;
  assert!(
    numbering
      .contains("<w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"\u{f0b7}\"/>")
  );
  assert!(numbering.contains(
    "<w:rFonts w:ascii=\"Symbol\" w:cs=\"Symbol\" w:hAnsi=\"Symbol\" w:hint=\"default\"/>"
  ));
  let styles = part(&prepared.document, "word/styles.xml")?;
  assert!(styles.contains("<w:vertAlign w:val=\"superscript\"/>"));

  assert_metadata_removed(NOTES_BULLETS_GRID, &prepared)?;
  assert_stable_export(&prepared)
}

#[test]
fn exports_east_asian_font_hint_and_character_grid()
-> Result<(), Box<dyn std::error::Error>> {
  let prepared = prepare_docx_anonymized_export(EAST_ASIAN_HINT_GRID)?;

  assert_eq!(
    part_names(&prepared.document)?,
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/theme/theme1.xml",
    ]
  );
  assert_eq!(prepared.report.removed_part_count, 5);
  assert_eq!(prepared.report.sanitized_xml_part_count, 6);
  assert_eq!(
    block_texts(&prepared),
    ["Synthetic heading text.", "合成テキストの段落です。"]
  );

  let document = part(&prepared.document, "word/document.xml")?;
  assert!(document.contains(
    "<w:r><w:rPr><w:rFonts w:hint=\"eastAsia\"/></w:rPr><w:t>合成テキストの段落です。</w:t></w:r>"
  ));
  assert!(document.contains(
    "<w:docGrid w:charSpace=\"24576\" w:linePitch=\"360\" w:type=\"snapToChars\"/>"
  ));
  let styles = part(&prepared.document, "word/styles.xml")?;
  assert!(styles.contains("w:eastAsia=\"SimSun\""));

  assert_metadata_removed(EAST_ASIAN_HINT_GRID, &prepared)?;
  assert_stable_export(&prepared)
}
