# PII redaction surfaces

PII redaction is a pipeline property, not only a detector API. A usable surface
must define input boundaries, format coverage, output handling, session
lifetime, restoration, and what metadata can still carry PII.

## Current coverage

| Surface                            | Node | Python | WASM | CLI | Local MCP            |
| ---------------------------------- | ---- | ------ | ---- | --- | -------------------- |
| In-memory text detection/redaction | Yes  | Yes    | Yes  | Yes | Via file paths       |
| Caller detections and operators    | Yes  | Yes    | Yes  | Yes | Not exposed yet      |
| Streaming text results             | Yes  | Yes    | Yes  | No  | No                   |
| Cross-document sessions            | Yes  | Yes    | Yes  | Yes | In-memory            |
| Encrypted session transfer         | Yes  | Yes    | No   | Yes | Not exposed yet      |
| DOCX extraction/coverage           | Yes  | Yes    | No   | Yes | Aggregate inspection |
| DOCX rewrite/anonymize/restore     | Yes  | Yes    | No   | Yes | Yes                  |
| Runtime capability discovery       | Yes  | Yes    | Yes  | Yes | Fixed tool list      |

Node and Python DOCX adapters share bounded extraction, rewrite, and restoration
planning in Rust. Availability gates require every surface in a parity profile,
and committed behavioral vectors run through both bindings.

The local MCP server deliberately exposes a narrower workflow surface. It uses
stdio only, requires explicit absolute input and output paths under configured
roots, rejects symlink escapes and overwrites, and returns aggregate summaries
without document text or plaintext mappings.

## Format-level gaps

DOCX coverage is intentionally fail-closed. Text in main documents, headers,
footers, footnotes, endnotes, comments, tables, and text boxes is mapped.
Unrewritten metadata, custom XML, external relationship targets, symbols, field
instructions, alternate content, and other package parts are reported as
coverage gaps. Partial anonymization requires explicit opt-in.

The repository does not yet provide structure-preserving pipelines for PDF,
XLSX, PPTX, HTML, Markdown, CSV, email containers, images/OCR, archives, or
database records. Plain UTF-8 representations can use the text engine, but that
does not preserve or inventory their original format structure.

## Workflow gaps

- Durable MCP sessions, encrypted export/import, expiry policy, and recovery
  after server restart are not exposed. The lower-level runtimes and CLI already
  provide encrypted session archives.
- MCP review/correction tools and an MCP Apps user interface are not present.
  Caller detections exist in the runtime APIs and can support a later review
  surface without changing the detector core.
- Batch and recursive MCP operations are not present. The CLI already covers
  batch text and DOCX workflows.
- Audit logging is left to the MCP host. Tool results are audit-safe, but the
  server does not create a separate local audit ledger.
- There is no MCP resource that exposes anonymized output. This is deliberate:
  the host receives only a path and decides whether to read the safe output.

Compared with PII-Shield, stella now has the same essential local path-only MCP
boundary for text and DOCX, backed by one Rust document contract across Node and
Python. PII-Shield additionally covers PDF/Markdown/CSV, durable mapping stores,
review UI, encrypted team handoff, batch/chunk tools, and local audit logs; those
remain explicit future surfaces rather than implicit claims.
