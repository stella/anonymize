# stella anonymize PDF inspection core

This crate provides a bounded, fail-closed PDF structure and page-observation
contract. It does not redact PDFs. In particular, it never treats a rectangle
drawn over original page content as anonymization.

The built-in inspector inventories document structures that can retain personal
data. Page text, glyph geometry, rendered images, and OCR coverage come from an
explicit observation provider. A later renderer can implement that provider and
produce destructive raster output without changing the inspection contract.

Observations are accepted only in a versioned batch bound to the exact PDF
bytes by lowercase SHA-256, with a required provider ID, name, and version.
Loose observation arrays are not supported. Coverage is only
`provider-attested-full` when that provider asserts every page was rendered,
its text layer was completely observed, and OCR completely covered the rendered
page pixels. This records provider provenance; the core does not independently
prove the provider's claim. The pixel requirement applies even when the PDF has
no image objects because visible text can be encoded as vector outlines.

Strict inspection accepts classic PDF 1.0–1.4 files only. PDF 1.5+ object and
cross-reference streams are rejected because the parser cannot enforce one
aggregate decompression budget across them. Observation geometry uses the
effective inherited CropBox after page rotation, with its origin normalized to
`(0, 0)`. Incremental revisions and non-whitespace bytes after `%%EOF` are
reported as retained-document-byte coverage gaps. Encrypted PDFs are rejected
fail-closed rather than inspected through an incomplete encrypted object graph.
