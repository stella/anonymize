# @stll/anonymize-corpus

Private tooling for evaluating the detection pipeline against real-world
documents. It keeps a permanent record of which documents have been pulled and
which detection spans have already been triaged, so each evaluation round only
looks at what changed.

## Data layout

```
corpus/
  manifest.json        committed   every document ever fetched (id, source, query, sha256)
  skiplist.json        committed   ids the fetcher saw but did not store
  raw/                 gitignored  plain-text document bodies, re-fetchable via the manifest
  runs/                gitignored  per-document pipeline output, keyed by content hash
  triage/              gitignored  generated diff reports containing detected spans
  verdicts/
    edgar/             committed   triaged spans for public SEC filings
    case-law/          gitignored  triaged spans quoting personal data stay local
```

Document bodies are never committed. EDGAR filings are public, but the corpus
can grow large and is always re-fetchable; case-law text contains personal data
and must stay out of the public repository entirely (only citation identifiers
go in the manifest).

## Workflow

**Prerequisites.** The tools import the workspace packages from their built
`dist/` output (gitignored). On a fresh clone run `bun install && bun run build`
from the repo root (turbo builds the workspace packages) before first use.

1. **Fetch** new documents. The manifest is the memory: known ids are skipped,
   so repeated searches never re-download or re-introduce documents. Documents
   that fail the size bounds are recorded in `skiplist.json` so the same
   oversized or stub filings are not re-downloaded on every search.

   ```sh
   EDGAR_USER_AGENT="name email@example.com" \
     bun src/fetch.ts --query "employment agreement" --query "lease agreement" --limit 25
   ```

   On a fresh clone `corpus/raw/` is empty (it is gitignored) while
   `manifest.json` is committed. Use `--refill` to restore the raw bodies for
   every committed manifest entry: it re-downloads each missing document, re-runs
   extraction, and verifies the result still matches the recorded `sha256`. A
   mismatch means the extraction logic changed since the document was recorded
   and fails loudly. `--refill` ignores `--query` and adds no new documents.

   ```sh
   EDGAR_USER_AGENT="name email@example.com" bun src/fetch.ts --refill
   ```

2. **Run** the rules pipeline (NER off, same configuration as
   `scripts/contract-perf.mjs`) over the whole corpus. Artifacts land in
   `corpus/runs/<git-sha>/<sha256>-<doc-id-hash>.json`, so separate filings
   with identical extracted text remain separate documents.

   ```sh
   bun src/run.ts
   ```

3. **Diff** the run to get the triage queue. Without `--baseline` every span is
   a candidate; with one, only spans that appeared or disappeared. The diff is
   verdict-aware and reports four buckets per document:
   - `added`: new, unjudged spans (FP candidates to triage).
   - `removed`: disappeared, unjudged spans (FN candidates to triage).
   - `regressions`: spans judged `tp` that the run no longer detects; derived
     from the verdicts themselves, so they surface with or without a baseline.
   - `fixed`: spans previously judged `fn` that the pipeline now detects.

   Spans judged `tp`/`fp` are not re-surfaced as candidates, and a vanished `fp`
   is expected and dropped, so triage effort is never repeated while genuine
   regressions still appear.

   ```sh
   mkdir -p corpus/triage
   bun src/diff.ts --run abc1234 --baseline def5678 > corpus/triage/triage.json
   ```

4. **Triage** the candidates (manually or with an LLM assist) and record the
   outcome as verdict files, one per document, named by content hash:

   ```json
   {
     "docId": "0000320193-24-000001:ex10-1.htm",
     "sha256": "…",
     "spans": [
       {
         "start": 120,
         "end": 128,
         "value": "Jane Doe",
         "label": "person",
         "verdict": "tp"
       },
       {
         "start": 512,
         "end": 521,
         "value": "Acme Corp",
         "label": "organization",
         "verdict": "fn",
         "note": "missed: no legal-form suffix"
       }
     ]
   }
   ```

   Every span must quote the document verbatim at its offsets; `diff.ts`
   validates this and fails on mismatch. `tp` = correct detection, `fp` =
   detected but not PII, `fn` = PII the pipeline misses.

5. **Freeze** each confirmed bug as a regression test in `packages/anonymize`:
   a minimal detector test quoting the offending sentence, pinned with
   `test.failing` until fixed. Promote particularly representative documents
   into `src/__test__/fixtures/contracts/` so the committed snapshot suite
   covers them in CI.

Offsets in verdict files are UTF-16 code-unit indices (the same convention as
pipeline entities) and are stable because documents are content-addressed: a
changed document gets a new sha256 and starts with an empty verdict file.
