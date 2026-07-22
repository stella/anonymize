# PII redaction surfaces

PII redaction is a pipeline property, not only a detector API. A usable surface
must define input boundaries, format coverage, output handling, session
lifetime, restoration, and what metadata can still carry PII.

## Current coverage

| Surface                            | Node | Python | WASM | CLI | Local MCP            |
| ---------------------------------- | ---- | ------ | ---- | --- | -------------------- |
| In-memory text detection/redaction | Yes  | Yes    | Yes  | Yes | Via file paths       |
| Caller detections and operators    | Yes  | Yes    | Yes  | Yes | v1 sidecar paths     |
| Streaming text results             | Yes  | Yes    | Yes  | No  | No                   |
| Cross-document sessions            | Yes  | Yes    | Yes  | Yes | In-memory            |
| Encrypted session transfer         | Yes  | Yes    | No   | Yes | No; durable local    |
| DOCX extraction/coverage           | Yes  | Yes    | No   | Yes | Aggregate inspection |
| DOCX rewrite/anonymize/restore     | Yes  | Yes    | No   | Yes | Yes                  |
| PDF structure/coverage inspection  | Yes  | Yes    | Yes  | No  | No                   |
| PDF destructive raster output      | Yes  | Yes    | No   | No  | No                   |
| Runtime capability discovery       | Yes  | Yes    | Yes  | Yes | Manifest + tools     |

Node and Python DOCX adapters share bounded extraction, rewrite, and restoration
planning in Rust. Availability gates require every surface in a parity profile,
and committed behavioral vectors run through both bindings.

The local MCP server deliberately exposes a narrower workflow surface. It uses
stdio only, requires explicit absolute input and output paths under configured
roots, rejects symlink escapes and overwrites, and returns aggregate summaries
without document text or plaintext mappings. It supports opt-in encrypted
durable sessions on macOS and Linux and provider-neutral external detections
through bounded, digest-bound v1 JSON sidecar paths.

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

The provider-neutral raster surface accepts complete rendered/OCR page
observations and opaque RGB8 pixels, runs stella detection, merges optional
digest-bound external detections, requires every selected span to map to glyph
geometry, destructively fills those pixels, and writes a fresh image-only PDF
without retaining source objects. It is currently an SDK contract: no
renderer/OCR process adapter, CLI command, or MCP tool is bundled. Its
certificate explicitly sets `piiCleanGuaranteed` to false because complete OCR
coverage asserts that every page was processed, not that OCR or PII detection
has perfect recall. Raster output deliberately removes searchability,
accessibility, forms, links, attachments, metadata, and digital signatures.
Both `document.pdf.anonymize-raster` and the advanced
`document.pdf.rewrite-raster` seam are named document-profile capabilities, so
the exhaustive Node/Python parity gate covers each public API independently.

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
