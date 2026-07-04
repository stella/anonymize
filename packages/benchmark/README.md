# @stll/anonymize-benchmark

Reproducible comparison of `@stll/anonymize` (stella) against other open-source
PII redaction libraries on recall, precision, and throughput over a public,
synthetic, legal-domain corpus (en/cs/de). Intended to back the claims cited in
the top-level README.

## Layout

```text
fixtures/                 public-safe synthetic ground truth, per language (en/cs/de)
python/                   Presidio + scrubadub adapter scripts and pinned requirements
results/                  committed, date-stamped JSON + Markdown reports (+ latest.md)
src/
  taxonomy.ts             common 8-label taxonomy + per-library mapping tables
  ground-truth.ts         segment -> labelled document loader (offsets by construction)
  metrics.ts              span-overlap matching + precision/recall/F1
  report.ts               Markdown report renderer
  adhoc.ts                unseen-document mode: side-by-side detections, no gold
  bench.ts                runner: bun run bench:compare [--input <file|dir>]
  adapters/               stella, presidio, scrubadub, redact-pii adapters
REPRODUCING.md            exact versions, models, hardware, mapping decisions
```

## Running

```sh
# from repo root, once:
bun install && bun run build

# from packages/benchmark, set up the Python competitors (see REPRODUCING.md):
uv venv .venv-presidio  --python 3.11 && uv pip install --python .venv-presidio  -r python/requirements-presidio.txt   # + model wheels
uv venv .venv-scrubadub --python 3.11 && uv pip install --python .venv-scrubadub -r python/requirements-scrubadub.txt

# run:
bun run bench:compare
```

Libraries whose virtualenv is missing are reported as `unavailable` in the
report and skipped, rather than failing the run or being fabricated. (A venv
that exists but is missing its dependencies is likewise skipped with a
reinstall hint; any _other_ non-zero exit from a Python adapter is a real crash
and fails the run loudly instead of being hidden as `unavailable`.)

## Unseen-document mode (anti-overfitting escape hatch)

The committed corpus is curated, so good scores on it could in principle reflect
tuning to these fixtures. To check behaviour on text the benchmark has never
seen, run every available library over your own files with no ground truth:

```sh
bun run bench:compare --input path/to/file.txt
bun run bench:compare --input path/to/dir           # every readable file in dir
bun run bench:compare --input path/to/file.txt --lang de   # model hint (default en)
```

This is a behaviour comparison, not a scored benchmark: there is no
recall/precision (no gold spans). For each document it prints an aligned table
of detected spans, one row per detection region, with the offset range, common
label, a truncated excerpt, and each library's own span (or `·` if it missed
the region). It also prints per-library span totals and, for every competitor,
pairwise agreement vs stella (`both` / `stella only` / `competitor only`) over
the aligned regions. Paste any previously unseen file and compare directly.

> PRIVACY: unseen-document mode quotes excerpts of the detected entities from
> your input into the report. Pasting a sensitive file therefore prints its
> entities to disk. Output is written to `results/adhoc/` (a date-stamped
> Markdown file), which is git-ignored precisely so these reports are never
> committed. Do not commit or share them if the input was sensitive.

## Honesty

- Ground truth is independent of stella: the repo's `.snapshot.json` fixtures
  are stella's own output and are not used here.
- Every label is reported, including those where stella loses (e.g. Presidio
  scores higher recall on `organization` and `person`).
- The corpus is legal-domain and multilingual, which favours stella; this caveat
  is stated in every generated report. A per-language table isolates the
  English-only comparison.
- Competitor versions are pinned and quoted; taxonomy mappings are deliberately
  generous to competitors. See `REPRODUCING.md`.
