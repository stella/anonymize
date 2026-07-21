# stella anonymize PDF inspection core

This crate provides a bounded, fail-closed PDF structure and page-observation
contract. It does not redact PDFs. In particular, it never treats a rectangle
drawn over original page content as anonymization.

The built-in inspector inventories document structures that can retain personal
data. Page text, glyph geometry, rendered images, and OCR coverage come from an
explicit observation provider. A later renderer can implement that provider and
produce destructive raster output without changing the inspection contract.

Observations are accepted only as a versioned batch bound to the exact PDF
bytes by lowercase SHA-256, with a required bounded provider ID, name, and
version. Loose observation arrays are rejected. `provider-attested-full`
records the provider's assertion; the core does not independently prove what a
renderer or OCR engine observed.

Page-tree traversal is strict and bounded while supporting PDF 1.5
cross-reference and object streams. Renderer dimensions are checked against
effective page boxes, rotation, and UserUnit scaling; complete text-layer
observations require exact UTF-16 glyph coverage.
Every span used to attest a complete text layer must have the `embedded-text`
source; OCR geometry cannot stand in for embedded-layer coverage.

Incremental revision markers and non-whitespace bytes after the final `%%EOF`
are reported as retained-document risks and prevent full coverage. Inspection
covers the current object graph; it does not claim to inspect superseded
revision contents.

The lopdf load option bounds each decompressed object or cross-reference stream.
After parsing, this crate also bounds aggregate loaded string, name,
dictionary-key, and stream payload. The aggregate pass cannot retroactively
prevent parser intermediate allocations, so the input-byte bound remains a
separate security boundary.

Encrypted PDFs are rejected fail-closed before any potentially incomplete
object inventory is returned.

Coverage is only `provider-attested-full` when every page was rendered, its text layer was
completely observed, and OCR completely covered the rendered page pixels. The
pixel requirement applies even when the PDF has no image objects because
visible text can be encoded as vector outlines.
