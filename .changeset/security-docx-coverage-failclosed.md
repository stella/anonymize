---
"@stll/anonymize-docx": patch
---

Fail closed on DOCX coverage gaps: hyperlink relationship targets
(`mailto:`/`tel:` in `*.rels`) and document metadata parts (`docProps/*`,
`customXml/*`) are now surfaced as unsupported coverage instead of being
silently reported as fully covered, so `require-full` no longer passes a
document that would leak PII in those parts. Also adds aggregate work budgets to
extraction (segment×depth) and rewrite (planned replacement bytes) so crafted
inputs cannot exhaust memory before existing size checks fire.

Note: because nearly all real documents carry `docProps/core.xml`, callers
relying on `require-full` will now need `allow-partial` (or metadata redaction)
until metadata redaction lands.
