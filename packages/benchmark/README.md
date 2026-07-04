# @stll/anonymize-benchmark

Reproducible comparison of `@stll/anonymize` (stella) against other open-source
PII redaction libraries on recall, precision, and throughput over a public,
synthetic, legal-domain corpus (en/cs/de). Intended to back the claims cited in
the top-level README.

## Layout

```
fixtures/                 public-safe synthetic ground truth, per language (en/cs/de)
python/                   Presidio + scrubadub adapter scripts and pinned requirements
results/                  committed, date-stamped JSON + Markdown reports (+ latest.md)
src/
  taxonomy.ts             common 8-label taxonomy + per-library mapping tables
  ground-truth.ts         segment -> labelled document loader (offsets by construction)
  metrics.ts              span-overlap matching + precision/recall/F1
  report.ts               Markdown report renderer
  bench.ts                runner: bun run bench:compare
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
report and skipped, rather than failing the run or being fabricated.

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
