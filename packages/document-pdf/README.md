# `@stll/anonymize-pdf`

Bounded PDF structure and coverage inspection for local anonymization workflows.

This package does **not** anonymize or redact PDFs. Inspection results inventory
structures that can retain sensitive data, including forms, annotations,
attachments, metadata, JavaScript, XFA, optional content, signatures, and image
objects. A black rectangle drawn over a PDF page is not redaction because the
original text or image can remain underneath it.

```ts
import { readFile } from "node:fs/promises";
import { inspectPdf } from "@stll/anonymize-pdf";

const inspection = inspectPdf(await readFile("contract.pdf"));
console.log(inspection.risks);
console.log(inspection.coverage);
```

Without page observations from a renderer/OCR adapter, coverage is explicitly
`partial` with `page-content-not-observed`. The optional observation contract
uses UTF-16 text offsets and PDF points. It is the seam for a later PDFium-backed
renderer and destructive raster workflow; callers must not describe inspection
alone as anonymization.

Coverage is only `full` when every page was rendered, its text layer was
completely observed, and OCR completely covered the rendered page pixels. That
includes vector outlines, not only PDF image objects.

Strict inspection accepts classic PDF 1.0–1.4 files only. PDF 1.5+ object and
cross-reference streams fail closed. Page dimensions are the effective,
rotated CropBox in points, normalized to origin `(0, 0)`. Incremental revisions
and trailing retained bytes prevent `full` coverage.
