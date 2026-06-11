import { parseArgs } from "node:util";

import { createEdgarClient, type EdgarDocumentRef } from "./edgar";
import { sha256Hex } from "./hash";
import { htmlToText, looksLikeHtml } from "./html-text";
import { loadManifest, mergeManifestEntries, saveManifest } from "./manifest";
import { rawPath } from "./paths";
import type { ManifestEntry } from "./types";

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

Searches EDGAR full-text search for material contracts (EX-10),
skips documents already in the manifest, stores plain text under
corpus/raw/, and records new entries in corpus/manifest.json.

Requires ${USER_AGENT_ENV} (the SEC asks for a descriptive
User-Agent with contact info, e.g. "name email@example.com").`;

const { values } = parseArgs({
  options: {
    query: { type: "string", multiple: true },
    limit: { type: "string" },
    pages: { type: "string" },
    forms: { type: "string" },
  },
});

const queries = values.query ?? [];
if (queries.length === 0) {
  console.error(usage);
  process.exit(1);
}

const userAgent = process.env[USER_AGENT_ENV];
if (!userAgent) {
  console.error(`${USER_AGENT_ENV} is not set.\n\n${usage}`);
  process.exit(1);
}

const limit = Number(values.limit ?? DEFAULT_LIMIT_PER_QUERY);
const pages = Number(values.pages ?? DEFAULT_PAGES_PER_QUERY);
const forms = values.forms ?? DEFAULT_FORMS;

const client = createEdgarClient({ userAgent });
const manifest = await loadManifest();
const knownIds = new Set(manifest.entries.map((entry) => entry.id));

const extractText = (ref: EdgarDocumentRef, body: string): string =>
  HTML_EXTENSION_RE.test(ref.filename) || looksLikeHtml(body)
    ? htmlToText(body)
    : body.trim();

const newEntries: ManifestEntry[] = [];

for (const query of queries) {
  const refs = await client.searchMaterialContracts({ query, forms, pages });
  const fresh = refs.filter(
    (ref) => !knownIds.has(ref.id) && !newEntries.some((e) => e.id === ref.id),
  );
  console.error(
    `query "${query}": ${refs.length} hits, ${fresh.length} new, taking up to ${limit}`,
  );

  let taken = 0;
  for (const ref of fresh) {
    if (taken >= limit) {
      break;
    }
    const body = await client.fetchDocument(ref);
    const text = extractText(ref, body);
    if (text.length < MIN_DOC_CHARS || text.length > MAX_DOC_CHARS) {
      console.error(`  skip ${ref.id}: ${text.length} chars`);
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
console.error(
  `done: ${added.length} documents added, manifest now has ${merged.entries.length}`,
);
