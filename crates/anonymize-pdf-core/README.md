# stella anonymize PDF inspection core

This crate provides a bounded, fail-closed PDF structure and page-observation
contract. It does not redact PDFs. In particular, it never treats a rectangle
drawn over original page content as anonymization.

The built-in inspector inventories document structures that can retain personal
data, including otherwise-unreferenced action dictionaries and reusable Form
XObject streams. Page text, glyph geometry, rendered images, and OCR coverage
come from an explicit observation provider. A later renderer can implement that
provider and produce destructive raster output without changing the inspection
contract.

Page-tree traversal is strict and bounded while supporting PDF 1.5
cross-reference and object streams. Renderer dimensions are checked against
effective page boxes, rotation, and UserUnit scaling; complete text-layer
observations require exact UTF-16 glyph coverage.

Incremental revision markers and non-whitespace bytes after the final `%%EOF`
are reported as retained-document risks and prevent full coverage. Inspection
covers the current object graph; it does not claim to inspect superseded
revision contents.

The lopdf load option bounds each decompressed object or cross-reference stream.
After parsing, this crate also bounds aggregate loaded string, name,
dictionary-key, and stream payload. The aggregate pass cannot retroactively
prevent parser intermediate allocations, so the input-byte bound remains a
separate security boundary.

Coverage is only `full` when every page was rendered, its text layer was
completely observed, and OCR completely covered the rendered page pixels. The
pixel requirement applies even when the PDF has no image objects because
visible text can be encoded as vector outlines.
