use std::{
  alloc::{GlobalAlloc, Layout, System},
  cell::Cell,
  io::{Cursor, Read as _, Write as _},
};

use stella_anonymize_docx_core::{
  DOCX_XML_MAX_DEPTH, prepare_docx_anonymized_export,
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

// Counts heap bytes requested by the current thread so the test can bound the
// export's work deterministically instead of timing it.
struct CountingAllocator;

thread_local! {
  static ALLOCATED_BYTES: Cell<usize> = const { Cell::new(0) };
}

fn record_allocation(size: usize) {
  let _ = ALLOCATED_BYTES
    .try_with(|bytes| bytes.set(bytes.get().saturating_add(size)));
}

#[expect(
  unsafe_code,
  reason = "a global allocator must implement the unsafe GlobalAlloc trait; \
            every call delegates unchanged to the system allocator"
)]
// SAFETY: each method forwards its arguments unchanged to `System`, which
// upholds the `GlobalAlloc` contract; counting only touches a thread-local
// `Cell` and never allocates.
unsafe impl GlobalAlloc for CountingAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    record_allocation(layout.size());
    // SAFETY: the caller's layout contract is forwarded unchanged.
    unsafe { System.alloc(layout) }
  }

  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    record_allocation(layout.size());
    // SAFETY: the caller's layout contract is forwarded unchanged.
    unsafe { System.alloc_zeroed(layout) }
  }

  unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
    // SAFETY: the pointer and layout come from this allocator, which
    // obtained them from `System`.
    unsafe { System.dealloc(pointer, layout) }
  }

  unsafe fn realloc(
    &self,
    pointer: *mut u8,
    layout: Layout,
    new_size: usize,
  ) -> *mut u8 {
    record_allocation(new_size);
    // SAFETY: the pointer, layout and size contract are forwarded unchanged.
    unsafe { System.realloc(pointer, layout, new_size) }
  }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

const WORD_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const TEXT_BYTES: usize = 1024 * 1024;
const SYNTHETIC_WORD: &str = "synthetic ";
// document, body, then table, row and cell per nested table, then paragraph,
// run and text: the deepest nesting the shared XML limit admits.
const NESTED_TABLES: usize = DOCX_XML_MAX_DEPTH.saturating_sub(6).div_euclid(3);

fn nested_table_document(
  tables: usize,
  text: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut document_xml =
    format!("<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body>");
  for _ in 0..tables {
    document_xml.push_str("<w:tbl><w:tr><w:tc>");
  }
  document_xml.push_str("<w:p><w:r><w:t>");
  document_xml.push_str(text);
  document_xml.push_str("</w:t></w:r></w:p>");
  for _ in 0..tables {
    document_xml.push_str("</w:tc></w:tr></w:tbl>");
  }
  document_xml.push_str("</w:body></w:document>");

  let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
  let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated);
  archive.start_file("[Content_Types].xml", options)?;
  archive.write_all(
    b"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
  )?;
  archive.start_file("_rels/.rels", options)?;
  archive.write_all(
    b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
  )?;
  archive.start_file("word/document.xml", options)?;
  archive.write_all(document_xml.as_bytes())?;
  Ok(archive.finish()?.into_inner())
}

fn export_allocated_bytes(
  document: &[u8],
  text: &str,
) -> Result<usize, Box<dyn std::error::Error>> {
  let before = ALLOCATED_BYTES.with(Cell::get);
  let prepared = prepare_docx_anonymized_export(document)?;
  let after = ALLOCATED_BYTES.with(Cell::get);
  let [block] = prepared.extraction.blocks.as_slice() else {
    return Err("the export must keep the single text block".into());
  };
  assert!(block.text == text, "the export must keep the full text");
  Ok(after.saturating_sub(before))
}

#[test]
fn export_work_does_not_scale_with_nesting_depth()
-> Result<(), Box<dyn std::error::Error>> {
  let text = SYNTHETIC_WORD.repeat(TEXT_BYTES.div_euclid(SYNTHETIC_WORD.len()));
  let flat = nested_table_document(0, &text)?;
  let nested = nested_table_document(NESTED_TABLES, &text)?;

  let flat_bytes = export_allocated_bytes(&flat, &text)?;
  let nested_bytes = export_allocated_bytes(&nested, &text)?;

  // Each pass (sanitize, then canonical revalidation) handles the text a
  // constant number of times. Copying descendants once per ancestor would
  // multiply the nested figure by the nesting depth (over 100 levels).
  assert!(
    nested_bytes <= flat_bytes.saturating_add(flat_bytes.div_euclid(4)),
    "nested export allocated {nested_bytes} bytes; flat export allocated {flat_bytes}"
  );
  assert!(
    nested_bytes <= TEXT_BYTES.saturating_mul(32),
    "nested export allocated {nested_bytes} bytes for {TEXT_BYTES} text bytes"
  );
  Ok(())
}

const XML_DECLARATION: &str =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const DRAWING_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const WORD_2010_NAMESPACE: &str =
  "http://schemas.microsoft.com/office/word/2010/wordml";
const WORD_CONTENT: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const OFFICE_RELS: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SIBLINGS: usize = 20_000;

// A package whose styles and theme parts are already canonical, so the
// export must reproduce them byte for byte.
fn formatting_document(
  styles: &str,
  theme: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
  let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated);
  for (path, content) in [
    (
      "[Content_Types].xml",
      format!(
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"{WORD_CONTENT}document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"{WORD_CONTENT}styles+xml\"/><Override PartName=\"/word/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/></Types>"
      ),
    ),
    (
      "_rels/.rels",
      format!(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
      ),
    ),
    (
      "word/_rels/document.xml.rels",
      format!(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"{OFFICE_RELS}/theme\" Target=\"theme/theme1.xml\"/></Relationships>"
      ),
    ),
    (
      "word/document.xml",
      format!(
        "<w:document xmlns:w=\"{WORD_NAMESPACE}\"><w:body><w:p><w:r><w:t>{SYNTHETIC_WORD}</w:t></w:r></w:p></w:body></w:document>"
      ),
    ),
    ("word/styles.xml", styles.to_owned()),
    ("word/theme/theme1.xml", theme.to_owned()),
  ] {
    archive.start_file(path, options)?;
    archive.write_all(content.as_bytes())?;
  }
  Ok(archive.finish()?.into_inner())
}

fn nested(open: &str, close: &str, depth: usize, payload: &str) -> String {
  let mut output = open.repeat(depth);
  output.push_str(payload);
  output.push_str(&close.repeat(depth));
  output
}

fn styles_part(run_properties: &str) -> String {
  format!(
    "{XML_DECLARATION}<w:styles xmlns:w=\"{WORD_NAMESPACE}\"><w:style w:styleId=\"stellaStyle1\" w:type=\"character\"><w:rPr>{run_properties}</w:rPr></w:style></w:styles>"
  )
}

fn theme_part(fill: &str) -> String {
  format!(
    "{XML_DECLARATION}<a:theme xmlns:a=\"{DRAWING_NAMESPACE}\" name=\"stella\"><a:themeElements><a:fmtScheme name=\"stella\"><a:fillStyleLst>{fill}</a:fillStyleLst></a:fmtScheme></a:themeElements></a:theme>"
  )
}

fn flat_theme() -> String {
  theme_part("<a:solidFill><a:srgbClr val=\"112233\"/></a:solidFill>")
}

fn plain_styles() -> String {
  styles_part("<w:b/>")
}

fn gradient_stops(prefix: &str, attribute_prefix: &str) -> String {
  let stop = format!(
    "<{prefix}:gs {attribute_prefix}pos=\"0\"><{prefix}:srgbClr {attribute_prefix}val=\"112233\"/></{prefix}:gs>"
  );
  format!("<{prefix}:gsLst>{}</{prefix}:gsLst>", stop.repeat(SIBLINGS))
}

fn text_outline(depth: usize) -> String {
  let fill = nested(
    "<w14:gradFill>",
    "</w14:gradFill>",
    depth.max(1),
    &gradient_stops("w14", "w14:"),
  );
  styles_part(&format!(
    "<w14:textOutline xmlns:w14=\"{WORD_2010_NAMESPACE}\" xmlns:a=\"{DRAWING_NAMESPACE}\">{fill}</w14:textOutline>"
  ))
}

// Exports a package whose formatting parts are canonical, checks that the
// named part comes back unchanged, and returns the bytes allocated.
fn formatting_export_bytes(
  styles: &str,
  theme: &str,
  path: &str,
) -> Result<usize, Box<dyn std::error::Error>> {
  let document = formatting_document(styles, theme)?;
  let before = ALLOCATED_BYTES.with(Cell::get);
  let prepared = prepare_docx_anonymized_export(&document)?;
  let after = ALLOCATED_BYTES.with(Cell::get);
  let mut archive = ZipArchive::new(Cursor::new(prepared.document))?;
  let mut exported = String::new();
  archive.by_name(path)?.read_to_string(&mut exported)?;
  let expected = if path.ends_with("styles.xml") {
    styles
  } else {
    theme
  };
  assert!(exported == expected, "{path} must be exported unchanged");
  Ok(after.saturating_sub(before))
}

// Parsing and revalidating each payload element allocates a bounded amount;
// copying descendants once per ancestor would add the nesting depth (over
// 100 levels) times the serialized payload instead.
const PAYLOAD_ELEMENT_MAX_BYTES: usize = 8 * 1024;

fn assert_depth_independent(
  flat_bytes: usize,
  nested_bytes: usize,
  serializer: &str,
) {
  assert!(
    nested_bytes <= flat_bytes.saturating_add(flat_bytes.div_euclid(4)),
    "nested {serializer} export allocated {nested_bytes} bytes; flat export allocated {flat_bytes}"
  );
  assert!(
    nested_bytes <= SIBLINGS.saturating_mul(PAYLOAD_ELEMENT_MAX_BYTES),
    "nested {serializer} export allocated {nested_bytes} bytes for {SIBLINGS} payload elements"
  );
}

#[test]
fn formatting_serialization_work_does_not_scale_with_nesting_depth()
-> Result<(), Box<dyn std::error::Error>> {
  let payload = "<w:color w:val=\"112233\"/>".repeat(SIBLINGS);
  // styles, style, the outer run properties, nested run properties, then the
  // payload elements.
  let depth = DOCX_XML_MAX_DEPTH.saturating_sub(5);
  let flat = styles_part(&payload);
  let deep = styles_part(&nested("<w:rPr>", "</w:rPr>", depth, &payload));
  let flat_bytes =
    formatting_export_bytes(&flat, &flat_theme(), "word/styles.xml")?;
  let nested_bytes =
    formatting_export_bytes(&deep, &flat_theme(), "word/styles.xml")?;
  assert_depth_independent(flat_bytes, nested_bytes, "formatting");
  Ok(())
}

#[test]
fn theme_serialization_work_does_not_scale_with_nesting_depth()
-> Result<(), Box<dyn std::error::Error>> {
  let stops = gradient_stops("a", "");
  // theme, themeElements, fmtScheme, fillStyleLst, nested gradient fills,
  // then the stop list, stop and colour.
  let depth = DOCX_XML_MAX_DEPTH.saturating_sub(8);
  let flat = theme_part(&nested("<a:gradFill>", "</a:gradFill>", 1, &stops));
  let deep =
    theme_part(&nested("<a:gradFill>", "</a:gradFill>", depth, &stops));
  let flat_bytes =
    formatting_export_bytes(&plain_styles(), &flat, "word/theme/theme1.xml")?;
  let nested_bytes =
    formatting_export_bytes(&plain_styles(), &deep, "word/theme/theme1.xml")?;
  assert_depth_independent(flat_bytes, nested_bytes, "theme");
  Ok(())
}

#[test]
fn text_outline_serialization_work_does_not_scale_with_nesting_depth()
-> Result<(), Box<dyn std::error::Error>> {
  // styles, style, run properties, outline, nested gradient fills, then the
  // stop list, stop and colour.
  let depth = DOCX_XML_MAX_DEPTH.saturating_sub(8);
  let flat = text_outline(1);
  let deep = text_outline(depth);
  let flat_bytes =
    formatting_export_bytes(&flat, &flat_theme(), "word/styles.xml")?;
  let nested_bytes =
    formatting_export_bytes(&deep, &flat_theme(), "word/styles.xml")?;
  assert_depth_independent(flat_bytes, nested_bytes, "text outline");
  Ok(())
}
