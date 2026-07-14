# @stll/anonymize-docx

Structure-aware DOCX text extraction and rewriting for stella anonymization
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

Inputs are bounded before decompression. Callers should treat extracted text as
sensitive.

## Structure-preserving rewrite

Pass an extracted block location, its expected text, and one or more block-local
replacement spans back to `rewriteDocxText`. The expected text makes stale plans
fail instead of applying offsets to a changed document.

```ts
import { extractDocxText, rewriteDocxText } from "@stll/anonymize-docx";

const block = extraction.blocks.at(0);
if (block === undefined) {
  throw new Error("The DOCX contains no extracted text blocks");
}
const rewritten = rewriteDocxText(document, [
  {
    location: block.location,
    expectedText: block.text,
    replacements: [{ start: 8, end: 17, replacement: "[PERSON_1]" }],
  },
]);
```

Replacements may span ordinary text runs; replacement text inherits the first
touched run while unaffected suffixes keep their original runs. Span offsets are
UTF-16 code-unit offsets into `block.text`, matching JavaScript string indexing.
Untouched ZIP entries and XML are preserved by content. Empty, overlapping,
cross-block, tab/break-crossing, revision-content, stale, and invalid-XML
replacements are rejected explicitly.

## Session-backed restoration

Restore session placeholders with a live, already-authorized session object.
The expected session ID is mandatory to prevent a session from being applied
to the wrong document:

```ts
import { restoreDocxText } from "@stll/anonymize-docx";
import { getDefaultNativePipeline } from "@stll/anonymize/native-node";

const anonymizer = getDefaultNativePipeline({ language: "en" });
const session = anonymizer.restoreEncryptedRedactionSession({
  archive: encryptedSessionArchive,
  key: applicationOwnedKey,
  expectedSessionId: "opaque_case_1",
});
const restored = restoreDocxText({
  document,
  session,
  expectedSessionId: "opaque_case_1",
});
```

Placeholders may span ordinary Word text runs. Restoration is block-local and
inherits the same stale, revision, signature, XML, and archive protections as
`rewriteDocxText`. Unknown or incomplete placeholders for the expected session
fail closed; placeholders from other session namespaces remain unchanged. The
DOCX never receives the session mapping or plaintext originals as metadata.
