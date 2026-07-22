# stella anonymize PDF core

This crate provides bounded, fail-closed PDF inspection and destructive raster
anonymization contracts. It never treats a rectangle drawn over original page
content as anonymization.

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

The low-level raster rewrite accepts SHA-256-bound, provider-asserted opaque
RGB8 pages, complete observations, and detection spans. It validates every
source page and its displayed geometry, requires every selected non-whitespace
UTF-16 unit to map to observed glyph geometry, and requires detection spans to
be ordered and non-overlapping, so binding is a bounded glyph sweep. It
destructively overwrites those pixels and constructs a fresh PDF whose only page
content is the sanitized image. Provider metadata identifies one explicit OCR
language pack. It reparses
the output, checks an exact object/resource/operator
allowlist, and verifies the decompressed image digests. No source object,
metadata, text layer, attachment, signature, or incremental revision is copied.
Encrypted PDFs are rejected. Detector assembly stays in the Node/Python SDKs;
this core rewrite function must not be presented as detection or as a PII-clean
guarantee.

Complete OCR coverage means the provider submitted every rendered page to its
OCR engine. It cannot prove OCR or detector recall. The provider boundary and
the deliberate loss of searchable, accessible, and interactive PDF structure
must remain visible to callers.
