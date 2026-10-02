// Policy tests for the anonymized export over synthetic packages that use
// every retained part family: body, header, footer, footnotes, endnotes,
// styles (with a Word 2010 text outline), numbering and theme.

use std::io::{Cursor, Read as _, Write as _};

use stella_anonymize_docx_core::{
  DocxBlockRewrite, DocxRewriteErrorCode, DocxTextReplacement,
  finalize_docx_anonymized_export, prepare_docx_anonymized_export,
  rewrite_docx_text, validate_docx_anonymized_export,
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

const CONTENT_TYPES: &str =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELS: &str =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD: &str =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_2010: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
const DRAWING: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WORD_CONTENT: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const THEME_CONTENT: &str =
  "application/vnd.openxmlformats-officedocument.theme+xml";
const MARKERS: [&str; 5] = [
  "SyntheticBodyMarker",
  "SyntheticHeaderMarker",
  "SyntheticFooterMarker",
  "SyntheticFootnoteMarker",
  "SyntheticEndnoteMarker",
];

type Parts = Vec<(String, String)>;
type TestResult = Result<(), Box<dyn std::error::Error>>;

fn paragraph(text: &str) -> String {
  format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
}

fn note(kind: &str, text: &str) -> String {
  format!(
    "<w:{kind}s xmlns:w=\"{WORD}\"><w:{kind} w:id=\"1\"><w:p><w:r><w:{kind}Ref/></w:r><w:r><w:t>{text}</w:t></w:r></w:p></w:{kind}></w:{kind}s>"
  )
}

fn relationship(id: &str, kind: &str, target: &str) -> String {
  format!(
    "<Relationship Id=\"{id}\" Type=\"{OFFICE_RELS}/{kind}\" Target=\"{target}\"/>"
  )
}

fn package_manifest(header: &str, header_id: &str) -> Parts {
  let override_part = |path: &str, content_type: &str| {
    format!("<Override PartName=\"/{path}\" ContentType=\"{content_type}\"/>")
  };
  let content_types = [
    override_part(
      "word/document.xml",
      &format!("{WORD_CONTENT}document.main+xml"),
    ),
    override_part(
      &format!("word/header{header}.xml"),
      &format!("{WORD_CONTENT}header+xml"),
    ),
    override_part("word/footer1.xml", &format!("{WORD_CONTENT}footer+xml")),
    override_part(
      "word/footnotes.xml",
      &format!("{WORD_CONTENT}footnotes+xml"),
    ),
    override_part("word/endnotes.xml", &format!("{WORD_CONTENT}endnotes+xml")),
    override_part("word/styles.xml", &format!("{WORD_CONTENT}styles+xml")),
    override_part(
      "word/numbering.xml",
      &format!("{WORD_CONTENT}numbering+xml"),
    ),
    override_part("word/theme/theme1.xml", THEME_CONTENT),
  ]
  .concat();
  let document_relationships = [
    relationship(header_id, "header", &format!("header{header}.xml")),
    relationship("rId3", "footer", "footer1.xml"),
    relationship("rId4", "footnotes", "footnotes.xml"),
    relationship("rId5", "endnotes", "endnotes.xml"),
    relationship("rId6", "styles", "styles.xml"),
    relationship("rId7", "numbering", "numbering.xml"),
    relationship("rId9", "theme", "theme/theme1.xml"),
  ]
  .concat();
  vec![
    (
      "[Content_Types].xml".to_owned(),
      format!("<Types xmlns=\"{CONTENT_TYPES}\">{content_types}</Types>"),
    ),
    (
      "_rels/.rels".to_owned(),
      format!(
        "<Relationships xmlns=\"{PACKAGE_RELS}\">{}</Relationships>",
        relationship("rId1", "officeDocument", "word/document.xml")
      ),
    ),
    (
      "word/_rels/document.xml.rels".to_owned(),
      format!(
        "<Relationships xmlns=\"{PACKAGE_RELS}\">{document_relationships}</Relationships>"
      ),
    ),
  ]
}

// `header` names the header part number and `header_id` its relationship
// identifier, both producer-chosen.
fn all_part_package(header: &str, header_id: &str) -> Parts {
  let [body, header_text, footer_text, footnote_text, endnote_text] = MARKERS;
  let mut parts = package_manifest(header, header_id);
  parts.extend([
    (
      "word/document.xml".to_owned(),
      format!(
        "<w:document xmlns:w=\"{WORD}\" xmlns:r=\"{OFFICE_RELS}\"><w:body><w:p><w:pPr><w:pStyle w:val=\"Synthetic\"/><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr><w:r><w:t>{body}</w:t></w:r><w:r><w:footnoteReference w:id=\"1\"/></w:r><w:r><w:endnoteReference w:id=\"1\"/></w:r></w:p><w:sectPr><w:headerReference w:type=\"default\" r:id=\"{header_id}\"/><w:footerReference w:type=\"default\" r:id=\"rId3\"/></w:sectPr></w:body></w:document>"
      ),
    ),
    (
      format!("word/header{header}.xml"),
      format!(
        "<w:hdr xmlns:w=\"{WORD}\">{}</w:hdr>",
        paragraph(header_text)
      ),
    ),
    (
      "word/footer1.xml".to_owned(),
      format!(
        "<w:ftr xmlns:w=\"{WORD}\">{}</w:ftr>",
        paragraph(footer_text)
      ),
    ),
    (
      "word/footnotes.xml".to_owned(),
      note("footnote", footnote_text),
    ),
    (
      "word/endnotes.xml".to_owned(),
      note("endnote", endnote_text),
    ),
    (
      "word/styles.xml".to_owned(),
      format!(
        "<w:styles xmlns:w=\"{WORD}\" xmlns:w14=\"{WORD_2010}\"><w:style w:type=\"paragraph\" w:styleId=\"Synthetic\"><w:rPr><w:b/><w14:textOutline w14:w=\"9525\"><w14:solidFill><w14:srgbClr w14:val=\"112233\"/></w14:solidFill></w14:textOutline></w:rPr></w:style></w:styles>"
      ),
    ),
    (
      "word/numbering.xml".to_owned(),
      format!(
        "<w:numbering xmlns:w=\"{WORD}\"><w:abstractNum w:abstractNumId=\"0\"><w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%1.\"/><w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num></w:numbering>"
      ),
    ),
    (
      "word/theme/theme1.xml".to_owned(),
      format!(
        "<a:theme xmlns:a=\"{DRAWING}\" name=\"Synthetic\"><a:themeElements><a:clrScheme name=\"Synthetic\"><a:dk1><a:srgbClr val=\"112233\"/></a:dk1></a:clrScheme><a:fontScheme name=\"Synthetic\"><a:majorFont><a:latin typeface=\"Calibri\" panose=\"414C4943453132333435\"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>"
      ),
    ),
  ]);
  parts
}

fn zip_parts(parts: &Parts) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for (path, content) in parts {
    writer.start_file(path.as_str(), SimpleFileOptions::default())?;
    writer.write_all(content.as_bytes())?;
  }
  Ok(writer.finish()?.into_inner())
}

fn unzip(document: &[u8]) -> Result<Parts, Box<dyn std::error::Error>> {
  let mut archive = ZipArchive::new(Cursor::new(document))?;
  let mut parts = Vec::new();
  for index in 0..archive.len() {
    let mut file = archive.by_index(index)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    parts.push((file.name().to_owned(), content));
  }
  Ok(parts)
}

fn assert_absent(document: &[u8], needle: &str) -> TestResult {
  for (path, content) in unzip(document)? {
    assert!(
      !path.contains(needle),
      "{needle} survives in entry name {path}"
    );
    assert!(!content.contains(needle), "{needle} survives in {path}");
  }
  Ok(())
}

#[test]
fn producer_part_numbers_and_relationship_ids_are_renumbered() -> TestResult {
  let ordinary = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("1", "rId2"),
  )?)?;
  let synthetic = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("2025550100", "rId2025550100"),
  )?)?;
  assert_eq!(
    synthetic.document, ordinary.document,
    "producer-chosen part numbers and relationship ids must not change the export"
  );
  assert_absent(&synthetic.document, "2025550100")?;
  let parts = unzip(&synthetic.document)?;
  let part = |name: &str| {
    parts
      .iter()
      .find(|(path, _)| path == name)
      .map(|(_, content)| content.as_str())
      .ok_or_else(|| format!("missing {name}"))
  };
  let relationships = part("word/_rels/document.xml.rels")?;
  assert!(relationships.contains(&format!(
    "<Relationship Id=\"rId4\" Type=\"{OFFICE_RELS}/header\" Target=\"header1.xml\"/>"
  )));
  assert!(
    part("word/document.xml")?
      .contains("<w:headerReference r:id=\"rId4\" w:type=\"default\"/>")
  );
  assert!(
    part("[Content_Types].xml")?.contains("PartName=\"/word/header1.xml\"")
  );
  assert_absent(&synthetic.document, "panose")?;
  assert_absent(&synthetic.document, "414C4943453132333435")?;
  Ok(())
}

#[test]
fn validation_rejects_producer_numbered_names() -> TestResult {
  let prepared = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("1", "rId2"),
  )?)?;
  let renamed = unzip(&prepared.document)?
    .into_iter()
    .map(|(path, content)| {
      (
        path.replace("header1.xml", "header7.xml"),
        content.replace("header1.xml", "header7.xml"),
      )
    })
    .collect::<Parts>();
  let failure = validate_docx_anonymized_export(&canonical_zip(renamed)?)
    .err()
    .ok_or("a producer-numbered part was accepted")?;
  assert_eq!(failure.code(), DocxRewriteErrorCode::UnsupportedReplacement);
  Ok(())
}

// Mirrors the export's archive writer so a tampered part is the only
// difference from a canonical package.
fn canonical_zip(
  mut parts: Parts,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  parts.sort_unstable();
  let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated);
  let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
  for (path, content) in parts {
    writer.start_file(path, options)?;
    writer.write_all(content.as_bytes())?;
  }
  Ok(writer.finish()?.into_inner())
}

#[test]
fn canonical_zip_reproduces_the_export_archive() -> TestResult {
  let prepared = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("1", "rId2"),
  )?)?;
  assert_eq!(
    canonical_zip(unzip(&prepared.document)?)?,
    prepared.document
  );
  Ok(())
}

#[test]
fn every_part_is_rewritten_without_surviving_markers() -> TestResult {
  let prepared = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("1", "rId2"),
  )?)?;
  for marker in MARKERS {
    assert!(
      prepared
        .extraction
        .blocks
        .iter()
        .any(|block| block.text.contains(marker)),
      "{marker} must be exposed to the planner"
    );
  }
  let rewrites = prepared
    .extraction
    .blocks
    .iter()
    .filter(|block| !block.text.is_empty())
    .map(|block| DocxBlockRewrite {
      location: block.location.clone(),
      expected_text: block.text.clone(),
      replacements: vec![DocxTextReplacement {
        start: 0,
        end: block.text.encode_utf16().count(),
        replacement: "█".to_owned(),
      }],
    })
    .collect::<Vec<_>>();
  let rewritten = rewrite_docx_text(&prepared.document, &rewrites)?;
  let finalized = finalize_docx_anonymized_export(&rewritten.document)?;
  let extraction = validate_docx_anonymized_export(&finalized)?;
  assert!(
    extraction
      .blocks
      .iter()
      .all(|block| block.text.is_empty() || block.text == "█"),
    "every block must be fully rewritten"
  );
  for marker in MARKERS {
    assert_absent(&finalized, marker)?;
  }
  assert_absent(&finalized, "Synthetic")?;
  Ok(())
}

fn with_part(mut parts: Parts, path: &str, content: &str) -> Parts {
  parts.retain(|(existing, _)| existing != path);
  parts.push((path.to_owned(), content.to_owned()));
  parts
}

fn edit_part(
  parts: &Parts,
  path: &str,
  edit: impl Fn(&str) -> Option<String>,
) -> Result<Parts, Box<dyn std::error::Error>> {
  let mut edited = parts.clone();
  let (_, content) = edited
    .iter_mut()
    .find(|(existing, _)| existing == path)
    .ok_or_else(|| format!("missing {path}"))?;
  *content = edit(content).ok_or_else(|| format!("no anchor in {path}"))?;
  Ok(edited)
}

fn assert_export_rejects(parts: &Parts, context: &str) -> TestResult {
  let failure = prepare_docx_anonymized_export(&zip_parts(parts)?)
    .err()
    .ok_or_else(|| format!("{context} was accepted"))?;
  assert_eq!(
    failure.code(),
    DocxRewriteErrorCode::UnsupportedReplacement,
    "{context}"
  );
  Ok(())
}

#[test]
fn dangling_and_orphaned_relationships_reject() -> TestResult {
  let package = all_part_package("1", "rId2");
  let relationships_path = "word/_rels/document.xml.rels";
  for extra in [
    relationship("rId8", "header", "header9.xml"),
    format!("<Relationship Id=\"rId8\" Type=\"{OFFICE_RELS}/header\"/>"),
  ] {
    let dangling = edit_part(&package, relationships_path, |xml| {
      Some(xml.replace("</Relationships>", &format!("{extra}</Relationships>")))
    })?;
    assert_export_rejects(&dangling, &extra)?;
  }
  let orphan = with_part(
    package,
    "word/_rels/header9.xml.rels",
    &format!(
      "<Relationships xmlns=\"{PACKAGE_RELS}\">{}</Relationships>",
      relationship("rId1", "styles", "styles.xml")
    ),
  );
  assert_export_rejects(&orphan, "an orphaned relationships part")
}

// Each retained part family with an opening tag that may receive a child and
// an element name that may receive an attribute.
const FAMILIES: [(&str, &str, &str); 9] = [
  ("word/document.xml", "<w:body>", "<w:body"),
  ("word/header1.xml", "<w:r>", "<w:p"),
  ("word/footnotes.xml", "<w:p>", "<w:p"),
  ("word/styles.xml", "<w:rPr>", "<w:rPr"),
  ("word/styles.xml", "<w14:solidFill>", "<w14:solidFill"),
  ("word/numbering.xml", "<w:pPr>", "<w:pPr"),
  (
    "word/theme/theme1.xml",
    "<a:themeElements>",
    "<a:themeElements",
  ),
  ("word/_rels/document.xml.rels", "\">", "<Relationship "),
  ("[Content_Types].xml", "\">", "<Override "),
];
const UNKNOWN_ATTRIBUTE: &str =
  " xmlns:x=\"urn:synthetic\" x:marker=\"SyntheticMarker\" ";
const INJECTED_CHILDREN: [&str; 3] = [
  "<!--SyntheticMarker-->",
  "<?synthetic SyntheticMarker?>",
  "<x:unknown xmlns:x=\"urn:synthetic\">SyntheticMarker</x:unknown>",
];

#[test]
fn retained_families_reject_comments_instructions_and_unknown_markup()
-> TestResult {
  let package = all_part_package("1", "rId2");
  for (path, child_anchor, element) in FAMILIES {
    for child in INJECTED_CHILDREN {
      let injected = edit_part(&package, path, |xml| {
        xml.contains(child_anchor).then(|| {
          xml.replacen(child_anchor, &format!("{child_anchor}{child}"), 1)
        })
      })?;
      assert_export_rejects(&injected, &format!("{child} in {path}"))?;
    }
    let injected = edit_part(&package, path, |xml| {
      xml.contains(element).then(|| {
        xml.replacen(
          element,
          &format!("{}{UNKNOWN_ATTRIBUTE}", element.trim_end()),
          1,
        )
      })
    })?;
    assert_export_rejects(
      &injected,
      &format!("an unknown attribute on {element} in {path}"),
    )?;
  }
  Ok(())
}

// Inserts an attribute into the root element of an exported XML part.
fn with_root_attribute(xml: &str, attribute: &str) -> Option<String> {
  let declaration_end = xml.find("?>")?.checked_add(2)?;
  let root =
    declaration_end.checked_add(xml.get(declaration_end..)?.find('<')?)?;
  let name_end = root.checked_add(xml.get(root..)?.find([' ', '>', '/'])?)?;
  Some(format!(
    "{}{attribute}{}",
    xml.get(..name_end)?,
    xml.get(name_end..)?
  ))
}

#[test]
fn validation_rejects_an_unknown_attribute_in_any_exported_part() -> TestResult
{
  let prepared = prepare_docx_anonymized_export(&zip_parts(
    &all_part_package("1", "rId2"),
  )?)?;
  let parts = unzip(&prepared.document)?;
  assert_eq!(canonical_zip(parts.clone())?, prepared.document);
  for (path, _) in &parts {
    let tampered = edit_part(&parts, path, |xml| {
      with_root_attribute(xml, " synthetic=\"SyntheticMarker\"")
    })?;
    let failure = validate_docx_anonymized_export(&canonical_zip(tampered)?)
      .err()
      .ok_or_else(|| format!("an unknown attribute in {path} was accepted"))?;
    assert_eq!(
      failure.code(),
      DocxRewriteErrorCode::UnsupportedReplacement,
      "{path}"
    );
  }
  Ok(())
}
