---
"@stll/anonymize": patch
---

Keep partial-word boundary resolution responsive for large candidate sets by
indexing cross-label start and end positions instead of rescanning every span.
