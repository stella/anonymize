import { parseArgs } from "node:util";

import { createEdgarClient, isSupportedDocumentFile } from "./edgar";
import { sha256Hex } from "./hash";
import { htmlToText, looksLikeHtml } from "./html-text";
import { loadManifest, mergeManifestEntries, saveManifest } from "./manifest";
import { positiveIntegerOption } from "./options";
import { rawPath } from "./paths";
import { loadSkipList, mergeSkipEntries, saveSkipList } from "./skiplist";
import type { ManifestEntry, SkipEntry } from "./types";

const DEFAULT_FORMS = "8-K";
const DEFAULT_LIMIT_PER_QUERY = 25;
const DEFAULT_PAGES_PER_QUERY = 1;
const DEFAULT_LANGUAGE = "en";

/** Skip stub exhibits and oversized filings. */
const MIN_DOC_CHARS = 1_000;
const MAX_DOC_CHARS = 500_000;

const USER_AGENT_ENV = "EDGAR_USER_AGENT";

const HTML_EXTENSION_RE = /\.html?$/i;

const usage = `Usage: bun src/fetch.ts --query <phrase> [--query <phrase> ...]
       [--limit ${DEFAULT_LIMIT_PER_QUERY}] [--pages ${DEFAULT_PAGES_PER_QUERY}] [--forms ${DEFAULT_FORMS}]
       bun src/fetch.ts --refill

Searches EDGAR full-text search for material contracts (EX-10),
skips documents already in the manifest or skip list, stores plain
text under corpus/raw/, records new entries in corpus/manifest.json,
and appends size-skipped documents to corpus/skiplist.json.

--refill re-downloads every manifest document whose raw file is missing
(e.g. after a fresh clone, where corpus/raw/ is gitignored) and verifies
the re-extracted text still matches the recorded sha256. It ignores
--query and never adds new documents.

Requires ${USER_AGENT_ENV} (the SEC asks for a descriptive
User-Agent with contact info, e.g. "name email@example.com").`;

const { values } = parseArgs({
  options: {
    query: { type: "string", multiple: true },
    limit: { type: "string" },
    pages: { type: "string" },
    forms: { type: "string" },
    refill: { type: "boolean" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.error(usage);
  process.exit(0);
}

const userAgent = process.env[USER_AGENT_ENV];
if (!userAgent) {
  console.error(`${USER_AGENT_ENV} is not set.\n\n${usage}`);
  process.exit(1);
}

const client = createEdgarClient({ userAgent });

const extractText = (filename: string, body: string): string =>
  HTML_EXTENSION_RE.test(filename) || looksLikeHtml(body)
    ? htmlToText(body)
    : body.trim();

if (values.refill) {
  const manifest = await loadManifest();
  let repaired = 0;
  let skipped = 0;
  for (const entry of manifest.entries) {
    const path = rawPath(entry.id);
    if (await Bun.file(path).exists()) {
      continue;
    }
    if (entry.url === null) {
      console.error(`  skip ${entry.id}: no url (added manually)`);
      skipped += 1;
      continue;
    }
    const body = await client.fetchUrl(entry.url);
    const text = extractText(entry.id, body);
    const actualSha = sha256Hex(text);
    if (actualSha !== entry.sha256) {
      console.error(
        `refill ${entry.id}: sha mismatch (manifest ${entry.sha256}, re-extracted ${actualSha}).\n` +
          "The extraction logic has changed since this document was recorded; " +
          "the manifest sha256 no longer matches the current pipeline output.",
      );
      process.exit(1);
    }
    await Bun.write(path, text);
    repaired += 1;
    console.error(`  refilled ${entry.id} (${text.length} chars)`);
  }
  console.error(
    `refill done: ${repaired} documents restored, ${skipped} skipped (no url)`,
  );
  process.exit(0);
}

const queries = values.query ?? [];
if (queries.length === 0) {
  console.error(usage);
  process.exit(1);
}

let limit: number;
let pages: number;
try {
  limit = positiveIntegerOption({
    name: "limit",
    value: values.limit,
    fallback: DEFAULT_LIMIT_PER_QUERY,
  });
  pages = positiveIntegerOption({
    name: "pages",
    value: values.pages,
    fallback: DEFAULT_PAGES_PER_QUERY,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const forms = values.forms ?? DEFAULT_FORMS;

const manifest = await loadManifest();
const skipList = await loadSkipList();
const knownIds = new Set([
  ...manifest.entries.map((entry) => entry.id),
  ...skipList.entries.map((entry) => entry.id),
]);

const newEntries: ManifestEntry[] = [];
const newSkips: SkipEntry[] = [];

for (const query of queries) {
  const refs = await client.searchMaterialContracts({ query, forms, pages });
  const fresh = refs.filter(
    (ref) =>
      !knownIds.has(ref.id) &&
      !newEntries.some((entry) => entry.id === ref.id) &&
      !newSkips.some((entry) => entry.id === ref.id),
  );
  console.error(
    `query "${query}": ${refs.length} hits, ${fresh.length} new, taking up to ${limit}`,
  );

  let taken = 0;
  for (const ref of fresh) {
    if (taken >= limit) {
      break;
    }
    if (!isSupportedDocumentFile(ref.filename)) {
      const reason = `unsupported document type: ${ref.filename}`;
      console.error(`  skip ${ref.id}: ${reason}`);
      newSkips.push({ id: ref.id, reason });
      continue;
    }
    const body = await client.fetchDocument(ref);
    const text = extractText(ref.filename, body);
    if (text.length < MIN_DOC_CHARS || text.length > MAX_DOC_CHARS) {
      const reason = `size ${text.length} chars outside [${MIN_DOC_CHARS}, ${MAX_DOC_CHARS}]`;
      console.error(`  skip ${ref.id}: ${reason}`);
      newSkips.push({ id: ref.id, reason });
      continue;
    }
    await Bun.write(rawPath(ref.id), text);
    newEntries.push({
      id: ref.id,
      source: "edgar",
      url: ref.url,
      query,
      language: DEFAULT_LANGUAGE,
      sha256: sha256Hex(text),
      fetchedAt: new Date().toISOString(),
    });
    taken += 1;
    console.error(`  + ${ref.id} (${text.length} chars)`);
  }
}

const { manifest: merged, added } = mergeManifestEntries(manifest, newEntries);
await saveManifest(merged);

const { skipList: mergedSkips, added: skipsAdded } = mergeSkipEntries(
  skipList,
  newSkips,
);
await saveSkipList(mergedSkips);

console.error(
  `done: ${added.length} documents added, ${skipsAdded.length} size-skipped, ` +
    `manifest now has ${merged.entries.length}, skip list has ${mergedSkips.entries.length}`,
);
