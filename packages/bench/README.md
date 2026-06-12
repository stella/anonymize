# @stll/anonymize-bench

Reproducible quality and throughput benchmarks for `@stll/anonymize`.
Private workspace package; nothing here is published to npm.

## Running

```sh
bun install
bun run build            # bench imports the built @stll/anonymize dist
cd packages/bench
bun run bench            # quality + throughput + render results/RESULTS.md
```

Individual steps: `bun run bench:quality`, `bun run bench:throughput`
(`--iterations N --warmup N`), `bun run bench:render`. Results land in
`results/` as JSON plus a rendered `results/RESULTS.md`.

## Corpus

The corpus is the contract fixture set in
`packages/anonymize/src/__test__/fixtures/contracts/` (Czech, German,
and English legal contracts; public or synthetic documents, several
sourced from SEC EDGAR filings). The same fixtures gate releases via
the regression suite, so the benchmark always describes the pipeline
that actually ships.

All measurements run the deterministic layers only (`enableNer:
false`): regex, trigger phrases, legal forms, name corpus, deny
lists, coreference, hotword rules, and zone classification, with the
full published dictionary set from `@stll/anonymize-data` loaded the
way a production consumer loads it.

## Reference annotations, and what they can tell you

Quality is scored against the `.snapshot.json` sidecars next to each
fixture. These are produced by the pipeline itself and then human
reviewed: every change to them is diffed in PRs, and
`contract-snapshots.test.ts` plus `contract-quality.test.ts` pin
specific true positives and false positives that reviewers have
verified by hand.

Because the reference derives from reviewed pipeline output, the
pipeline's own score against it is close to perfect **by
construction**. That number is a drift detector, not proof of
accuracy. The honest uses of this harness are:

- **Cross-tool comparison.** Other tools' outputs (see interchange
  format below) are scored against the same reference with the same
  scorer; relative differences on identical documents are meaningful
  even when the reference has our bias. Comparisons should be read
  per label, restricted to labels both tools claim to detect
  (`--labels person,organization,...`).
- **Per-label and per-language coverage tracking** across releases.
- **Throughput**, which does not depend on the reference at all.

Independent third-party corpora are a planned extension; numbers on
this corpus alone should not be quoted as absolute accuracy claims.

## Scoring

Span-level, per label, one-to-one matching:

- **exact**: label, start, and end must all match.
- **overlap**: label must match and spans must share at least one
  character; gold spans claim the unmatched prediction with the
  largest overlap. For anonymization a partial hit still redacts part
  of the value, but exact mode is the honest headline metric.

Precision, recall, and F1 are reported per label, per language, and
micro-averaged. Offsets are UTF-16 code units; fixture text is
CRLF-normalized to match the regression suite.

## Comparing another tool

Run the tool over the same fixture files and write a predictions file:

```json
{
  "tool": "some-tool",
  "docs": [
    {
      "id": "en/software-license-agreement.txt",
      "entities": [{ "start": 100, "end": 117, "label": "date" }]
    }
  ]
}
```

Labels must be mapped to the canonical `@stll/anonymize` labels
(`person`, `organization`, `address`, `date`, ...) by the adapter
producing the file. Then:

```sh
bun run bench:quality -- --predictions path/to/predictions.json \
  --labels person,organization,email address,phone number,date
bun run bench:render
```

## Throughput methodology

One-time costs (dictionary load, search automaton preparation) are
measured separately from steady-state latency. The corpus is run
`--warmup` full passes (default 2), then `--iterations` measured
passes (default 10); per-document medians and corpus chars/second are
reported together with the Bun version and CPU model. Numbers in
committed results come from a developer laptop; treat them as
order-of-magnitude, and re-run locally for decisions.
