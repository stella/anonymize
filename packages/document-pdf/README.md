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
`partial` with `observation-provider-not-identified` and
`page-content-not-observed`. Observations must arrive as a versioned batch bound
to the exact input bytes by lowercase SHA-256 and must identify the provider by
ID, name, and version. Loose page-observation arrays are rejected. The contract
uses UTF-16 text offsets and PDF points.

Coverage is only `provider-attested-full` when that named provider asserts that
every page was rendered, its text layer was completely observed, and OCR
completely covered the rendered page pixels. This is provider provenance, not
an independent proof by the core. Pixel coverage includes vector outlines, not
only PDF image objects. Callers must not describe inspection alone as
anonymization.

Strict inspection accepts classic PDF 1.0–1.4 files only. PDF 1.5+ object and
cross-reference streams fail closed. Page dimensions are the effective,
rotated CropBox in points, normalized to origin `(0, 0)`. Incremental revisions
and trailing retained bytes prevent `provider-attested-full` coverage.
Encrypted PDFs are rejected fail-closed because the inspector cannot validate
their complete plaintext object graph without caller-supplied decryption.
