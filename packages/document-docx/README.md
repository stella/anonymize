# @stll/anonymize-docx

Structure-aware, read-only DOCX text extraction for stella anonymization
workflows.

```ts
import { readFile } from "node:fs/promises";
import { extractDocxText } from "@stll/anonymize-docx";

const extraction = extractDocxText(
  new Uint8Array(await readFile("contract.docx")),
);

for (const block of extraction.blocks) {
  console.log(block.location.type, block.text);
}
```

The extractor returns typed locations for ordinary paragraphs, table-cell
paragraphs, and text-box paragraphs across the main document, headers, footers,
footnotes, endnotes, and comments. Text segments retain hyperlink and tracked
revision context. Coverage metadata reports unsupported WordprocessingML parts,
symbols, and field instructions so callers do not silently treat a partial read
as complete. Markup-compatibility alternate content is also counted explicitly
because choice/fallback handling is not yet part of the extraction contract.

Inputs are bounded before decompression. This package does not yet rewrite or
restore DOCX files; callers should treat extracted text as sensitive.
