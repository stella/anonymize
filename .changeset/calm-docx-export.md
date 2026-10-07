---
"@stll/anonymize-docx": minor
---

Add an atomic anonymized DOCX export API that removes hidden document metadata, rejects unsupported content, and validates the rewritten package before returning it.

Validate XML nesting iteratively before recursive parsing and lower the exclusive nesting limit to 128 to reserve parser stack space.
