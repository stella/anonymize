# `@stll/anonymize-pdf`

Bounded PDF inspection and destructive raster anonymization contracts.

Inspection results inventory
structures that can retain sensitive data, including forms, annotations,
attachments, metadata, JavaScript, XFA, optional content, signatures, and image
objects. A black rectangle drawn over a PDF page is not redaction because the
original text or image can remain underneath it.

Incremental revisions and non-whitespace bytes after the final `%%EOF` marker
are reported as retained document bytes and prevent full coverage. The current
object graph is inspected; superseded revision contents are not claimed as
parsed or safe.

```ts
import { readFile } from "node:fs/promises";
import { inspectPdf } from "@stll/anonymize-pdf";

const inspection = inspectPdf(await readFile("contract.pdf"));
console.log(inspection.risks);
console.log(inspection.coverage);
```

Without page observations from a renderer/OCR adapter, coverage is explicitly
`partial` with `page-content-not-observed`. The optional observation contract
uses UTF-16 text offsets and PDF points. Page dimensions must match the
effective CropBox/MediaBox intersection after page rotation and UserUnit scaling
(within 0.25 points for renderer rounding). A `complete` text layer must map
every observed UTF-16 code unit to glyph geometry. It is the seam for a later
PDFium-backed renderer and destructive raster workflow; callers must not
describe inspection alone as anonymization.

Glyph bounds use a normalized displayed-page coordinate space in PDF points:
the effective visible page's bottom-left is `(0, 0)`, and CropBox translation,
page rotation, and UserUnit scaling have already been applied.

Coverage is only `full` when every page was rendered, its text layer was
completely observed, and OCR completely covered the rendered page pixels. That
includes vector outlines, not only PDF image objects.

lopdf enforces the decompression ceiling per object or cross-reference stream
during parsing. The inspector additionally bounds aggregate loaded string,
name, dictionary-key, and stream payload after parsing. That aggregate check is
not a guarantee that the parser allocated no intermediate memory before the
check; callers must also enforce the input-byte limit and process isolation
appropriate for untrusted files.

## Destructive raster anonymization

`anonymizePdfRaster` accepts pages produced by an explicit renderer/OCR
provider and creates a brand-new image-only PDF. It requires a prepared stella
pipeline, runs native detection over each page's observed text, merges an
optional digest-bound `ExternalDetectionBatch`, and fails if any selected
non-whitespace UTF-16 span is not completely mapped to observed glyph geometry.
Provider metadata must identify one explicit OCR language pack; mixed or
implicit language selection is not part of the contract.
It requires one opaque, row-packed RGB8 buffer for every source page, SHA-256
binds the source and each page, requires complete rendering and OCR assertions,
destructively fills the mapped pixels, and verifies both the newly written PDF
graph and its decompressed image pixels. Encrypted inputs are rejected.

The output never reuses source PDF objects, streams, text layers, metadata,
forms, annotations, attachments, actions, signatures, optional content, or
incremental revisions. A solid rectangle in this output is destructive: the
original pixels are absent rather than hidden underneath it. The tradeoff is
intentional loss of searchability, accessibility, links, forms, signatures,
and other interactive behavior.

The package does not bundle or silently select a renderer or OCR engine. A
provider's `complete` OCR assertion means every rendered page was submitted
to that OCR engine; it is not a claim that OCR or PII detection has perfect
recall. The returned certificate always says `piiCleanGuaranteed: false`:
verification proves a fresh image-only structure and the requested destructive
pixel rewrite, not perfect OCR or detector recall. Browser rendering is not
part of this surface. Raster anonymization is a Node and Python
document-profile capability; PDF inspection remains available through the
byte-oriented core runtimes.

`rewritePdfRasterFromDetections` is the advanced rewrite-only seam for trusted
adapters that already ran detection. Detection spans must be strictly ordered
and non-overlapping. Its name and certificate deliberately do not imply
detection or PII cleanliness.
