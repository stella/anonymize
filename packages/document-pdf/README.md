# `@stll/anonymize-pdf`

Bounded PDF structure and coverage inspection for local anonymization workflows.

This package does **not** anonymize or redact PDFs. Inspection results inventory
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

Without a renderer/OCR observation batch, coverage is explicitly `partial`.
The strict v1 batch is bound to the exact PDF bytes by lowercase SHA-256 and
requires a bounded provider ID, name, and version; loose page arrays are
rejected. The observation contract uses UTF-16 text offsets and PDF points.
Page dimensions must match the
effective CropBox/MediaBox intersection after page rotation and UserUnit scaling
(within 0.25 points for renderer rounding). A `complete` text layer must map
every observed UTF-16 code unit to glyph geometry. Each such span must be
sourced as `embedded-text`; OCR spans cannot stand in for embedded-layer
coverage. It is the seam for a later
PDFium-backed renderer and destructive raster workflow; callers must not
describe inspection alone as anonymization.

Glyph bounds use a normalized displayed-page coordinate space in PDF points:
the effective visible page's bottom-left is `(0, 0)`, and CropBox translation,
page rotation, and UserUnit scaling have already been applied.

Coverage is only `provider-attested-full` when every page was rendered, its text layer was
completely observed, and OCR completely covered the rendered page pixels. That
includes vector outlines, not only PDF image objects.

lopdf enforces the decompression ceiling per object or cross-reference stream
during parsing. The inspector additionally bounds aggregate loaded string,
name, dictionary-key, and stream payload after parsing. That aggregate check is
not a guarantee that the parser allocated no intermediate memory before the
check; callers must also enforce the input-byte limit and process isolation
appropriate for untrusted files.
