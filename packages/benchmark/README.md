# @stll/anonymize-benchmark

Reproducible comparison of `@stll/anonymize` (stella) against other open-source
PII redaction libraries on recall, precision, and throughput. The development
track includes a public synthetic legal-domain corpus (en/cs/de) and a declared
TAB development split. The evaluation-only suite unifies independently
published corpora without flattening their different task semantics into one
misleading score.

The package also has a separate evaluation-only blind track based on the pinned
test split of the third-party Text Anonymization Benchmark (TAB). TAB contains
real English ECHR decisions with human direct/quasi-identifier annotations. Its
test data is never used for detector development or tuning.

## Layout

```text
fixtures/                 public-safe synthetic ground truth, per language (en/cs/de)
python/                   Presidio + scrubadub adapter scripts and pinned requirements
results/                  committed, date-stamped JSON + Markdown reports (+ latest.md)
vendor/                   pinned third-party benchmark detector assets and licenses
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

# Aggregate-only blind evaluation over a deterministic 12-document TAB sample.
# Add --full for the entire 127-document test split.
bun run bench:blind

# Run every executable sealed corpus (TAB, RedactionBench, and MEDDOCAN).
bun run bench:suite

# Development-only five-document TAB comparison (aggregate by default).
bun run bench:dev-gap
# Explicitly opt in to printing public-corpus entity examples locally:
bun run bench:dev-gap --examples
# Restrict local examples to one TAB entity type (for example, organizations):
bun run bench:dev-gap --examples=ORG
```

`bench:blind` verifies the upstream file against a pinned SHA-256 digest before
loading it and writes only aggregate reports under `results/blind/`. Presidio
and scrubadub use the same optional virtual environments as `bench:compare`.
PII-Shield is included when its CLI and GLiNER model are installed; set
`PII_SHIELD_BIN` when the executable is not on `PATH`.

Blind results can reject a release, but must not be used to inspect examples or
tune behavior. See the repository instructions in `AGENTS.md`.

## Unified benchmark suite

`src/suite/registry.ts` is the governance and task registry for
`stella-anon-bench`. It keeps corpus provenance, version, license, language,
domain, access mode, and usage policy next to the task semantics. Corpora are
not flattened into one score when their annotations mean different things:

- TAB: span redaction over ECHR court decisions, with independent annotators.
  The unified suite runs all 127 test judgments, not the 12-document smoke set.
- RedactionBench: mandatory/contextual character spans over 200 heterogeneous
  English artifacts, including contracts, legal forms, medical documents,
  email, financial/government records, source code, files, logs, and terminals.
- MEDDOCAN: all 250 documents in the public Spanish clinical test split,
  loaded from its checksum-pinned Zenodo archive.
  Restricted or gated corpora are intentionally absent. A paper, model, dataset
  card, or click-through registration page is not enough: the runner only lists
  corpora it can retrieve as a versioned public artifact without credentials.

RedactionBench's official R-Score reference implementation is not yet
available. The suite therefore reports explicitly named interim metrics:
mandatory span recall, mandatory character recall, and character precision
where both mandatory and contextual spans are accepted. It does not label
those numbers as R-Score.

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
- The bundled synthetic development corpus is legal-domain and multilingual,
  which favours stella; this caveat is stated in every generated report. It is
  never presented as the sealed multi-corpus suite.
- Competitor versions are pinned and quoted; taxonomy mappings are deliberately
  generous to competitors. See `REPRODUCING.md`.
