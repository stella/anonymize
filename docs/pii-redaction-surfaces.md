# PII redaction surfaces

PII redaction is a pipeline property, not only a detector API. A usable surface
must define input boundaries, format coverage, output handling, session
lifetime, restoration, and what metadata can still carry PII.

## Current coverage

| Surface                                   | Node | Python | WASM | CLI       | Local MCP            |
| ----------------------------------------- | ---- | ------ | ---- | --------- | -------------------- |
| In-memory text detection/redaction        | Yes  | Yes    | Yes  | Yes       | Via file paths       |
| Caller detections and per-label operators | Yes  | Yes    | Yes  | No        | v1 sidecar paths     |
| Streaming text results                    | Yes  | Yes    | Yes  | No        | No                   |
| In-memory cross-document sessions         | Yes  | Yes    | Yes  | No        | Process-local        |
| Encrypted session archive import/export   | Yes  | Yes    | Yes  | DOCX only | No; managed store    |
| DOCX extraction/coverage API              | Yes  | Yes    | No   | No        | Aggregate inspection |
| DOCX rewrite/anonymize/restore            | Yes  | Yes    | No   | Yes       | Yes                  |
| PDF structure/coverage inspection         | Yes  | Yes    | Yes  | No        | No                   |
| PDF destructive raster output             | Yes  | Yes    | No   | Yes       | Yes, path-only       |
| Runtime capability discovery              | Yes  | No     | Yes  | Yes       | Manifest + tools     |

Node and Python DOCX adapters share bounded extraction, rewrite, and restoration
planning in Rust. Availability gates require every surface in a parity profile,
and committed behavioral vectors run through both bindings.

The local MCP server deliberately exposes a narrower workflow surface. It uses
stdio only, requires explicit absolute input and output paths under configured
roots, rejects symlink escapes and overwrites, and returns aggregate summaries
without document text or plaintext mappings. It supports opt-in encrypted
durable sessions on macOS and Linux and provider-neutral external detections
through bounded, digest-bound v1 JSON sidecar paths. Durable archives are owned
by the server's configured store; MCP clients cannot import or export them.

The CLI does not accept caller detections or the SDK's general per-label
operator map. Its cross-document session workflow is limited to DOCX commands,
which open or create an encrypted archive for each operation. It does not expose
standalone DOCX extraction or archive-transfer APIs.

PDF inspection parity includes the browser/WASM byte-oriented API. It does not
include a browser renderer or OCR provider; without provider observations the
inspection remains explicitly partial.

## Format-level gaps

DOCX coverage is intentionally fail-closed. Text in main documents, headers,
footers, footnotes, endnotes, comments, tables, and text boxes is mapped.
Unrewritten metadata, custom XML, external relationship targets, symbols, field
instructions, alternate content, and other package parts are reported as
coverage gaps. Partial anonymization requires explicit opt-in.

PDF inspection inventories forms, annotations, attachments, metadata,
JavaScript, XFA, optional content, signatures, image objects, and reusable Form
XObject streams. Page text and
glyph boxes use an explicit renderer/OCR observation contract; without those
observations, coverage is reported as partial. Inspection does not anonymize a
PDF. In particular, drawing an opaque rectangle over original page content is
not redaction because the covered text or image can remain in the file.

The provider-neutral raster surface accepts complete rendered/OCR observations
and RGB8 page pixels, runs detection, merges optional digest-bound external
detections, and requires every selected span to map to glyph geometry. It then
destructively fills those pixels and writes a fresh image-only PDF without
retaining source objects. Python callers provide observations and pixels from
their own renderer/OCR boundary. The Node adapter can instead invoke locally
installed Poppler and Tesseract; the CLI and MCP tools use that adapter. No
renderer, OCR model, or executable is bundled.

The certificate sets `piiCleanGuaranteed` to false: complete page processing
does not prove perfect OCR or detector recall. Raster output deliberately
removes searchability, accessibility, forms, links, attachments, metadata, and
digital signatures. The provider-neutral anonymize and lower-level rewrite
APIs are separate Node/Python parity capabilities. Local Poppler/Tesseract
observation is an explicit Node-only capability.

The repository does not yet provide PDF structure-preserving anonymization or
pipelines for XLSX, PPTX, HTML, Markdown, CSV, email containers, images/OCR,
archives, or database records. Plain UTF-8 representations can use the text
engine, but that does not preserve or inventory their original format structure.

## Workflow gaps

- MCP review/correction tools and an MCP Apps user interface are not present.
  External caller detections can enter through a sidecar, but there is no
  interactive span-review surface.
- Batch and recursive MCP operations are not present. The CLI already covers
  batch text and DOCX workflows.
- Audit logging is left to the MCP host. Tool results are audit-safe, but the
  server does not create a separate local audit ledger.
- There is no MCP resource that exposes anonymized output. This is deliberate:
  the host receives only a path and decides whether to read the safe output.

The remaining format and workflow gaps above are explicit future surfaces, not
implicit claims of coverage.
