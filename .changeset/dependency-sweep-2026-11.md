---
"@stll/anonymize": patch
"@stll/anonymize-docx": patch
"@stll/anonymize-pdf": patch
"@stll/anonymize-mcp": patch
---

Update text search to 2.0 (literal matches are selected globally across engine routes, independent of pattern order), the PDF parser to lopdf 0.47, fancy-regex to 0.20, and the native binding, DOCX and MCP dependencies. The prepared text-search artifact format changed: prepared pipeline packages persisted with an earlier release fail to load and must be prepared again with this release. Empty literal patterns are skipped instead of failing the whole search index.
