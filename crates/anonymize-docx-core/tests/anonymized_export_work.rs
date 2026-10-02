use std::{
  alloc::{GlobalAlloc, Layout, System},
  cell::Cell,
  io::{Cursor, Write as _},
};

use stella_anonymize_docx_core::{
  DOCX_XML_MAX_DEPTH, prepare_docx_anonymized_export,
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

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
) -> Result<usize, Box<dyn std::error::Error>> {
  let before = ALLOCATED_BYTES.with(Cell::get);
  let prepared = prepare_docx_anonymized_export(document)?;
  let after = ALLOCATED_BYTES.with(Cell::get);
  assert_eq!(
    prepared.extraction.blocks.len(),
    1,
    "the export must keep the single text block"
  );
  Ok(after.saturating_sub(before))
}

#[test]
fn export_work_does_not_scale_with_nesting_depth()
-> Result<(), Box<dyn std::error::Error>> {
  let text = SYNTHETIC_WORD.repeat(TEXT_BYTES.div_euclid(SYNTHETIC_WORD.len()));
  let flat = nested_table_document(0, &text)?;
  let nested = nested_table_document(NESTED_TABLES, &text)?;

  let flat_bytes = export_allocated_bytes(&flat)?;
  let nested_bytes = export_allocated_bytes(&nested)?;

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
