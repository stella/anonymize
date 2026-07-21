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

Raster anonymization accepts SHA-256-bound, provider-asserted opaque RGB8 pages
from an explicit
renderer/OCR provider. It validates every source page and its displayed
geometry, overwrites requested pixel regions, and constructs a fresh PDF whose
only page content is the sanitized image. It reparses the output, checks its
risk inventory and image-only object count, and verifies the decompressed image
digests. No source object, metadata, text layer, attachment, signature, or
incremental revision is copied. Encrypted PDFs are rejected.

Complete OCR coverage means the provider submitted every rendered page to its
OCR engine. It cannot prove OCR or detector recall. The provider boundary and
the deliberate loss of searchable, accessible, and interactive PDF structure
must remain visible to callers.
