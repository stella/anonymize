<p align="center">
  <img src=".github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

<p align="center">
  <strong>Anonymization pipeline for sensitive text. Deterministic, local-first, fast.</strong>
</p>

<p align="center">
  <a href="https://stll.app">Website</a> &middot;
  <a href="https://github.com/stella/anonymize/issues">Issues</a> &middot;
  <a href="https://www.npmjs.com/package/@stll/anonymize">npm</a> &middot;
  <a href="https://pypi.org/project/stella-anonymize-core/">PyPI</a> &middot;
  <a href="https://discord.gg/8dZjmVFjTK">Discord</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stll/anonymize"><img src="https://img.shields.io/npm/v/@stll/anonymize?label=%40stll%2Fanonymize" alt="npm" /></a>
  <a href="https://pypi.org/project/stella-anonymize-core/"><img src="https://img.shields.io/pypi/v/stella-anonymize-core?label=stella-anonymize-core&logo=pypi&logoColor=white" alt="PyPI" /></a>
  <a href="https://github.com/stella/anonymize/actions/workflows/ci.yml"><img src="https://github.com/stella/anonymize/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
  <a href="https://discord.gg/8dZjmVFjTK"><img src="https://img.shields.io/badge/discord-join%20chat-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

---

A single Rust core does the PII detection, resolution, and replacement; thin Node.js,
browser (WebAssembly), Python, and CLI bindings translate types and call into
it. There is no model server and no network dependency: the same document
produces the same redaction on every run and in every runtime. It is built for
legal documents (contracts, filings, correspondence) across a dozen languages,
and it is open source under the Apache-2.0 license.

## Quickstart

### Node.js

```bash
npm install @stll/anonymize
```

> still resolves to the stable 1.x line until 2.0.0 is promoted to `latest`.

```ts
import { getDefaultNativePipeline, deanonymise } from "@stll/anonymize";

const anonymize = getDefaultNativePipeline({ language: "en" });
const { redaction } = anonymize.redactText(
  "Contact Jan Novák at jan.novak@example.com.",
);

console.log(redaction.redactedText);
// Contact [PERSON_1] at [EMAIL_ADDRESS_1].
console.log(deanonymise(redaction.redactedText, redaction.redactionMap));
// Contact Jan Novák at jan.novak@example.com.
```

Create the pipeline once at startup and reuse it; it caches the prepared
package and search automata. If you know the document language, pass it so the
runtime loads the smaller scoped artifact — scoped packages ship for `cs`,
`de`, and `en` (other supported languages use the full default package;
requesting a scoped package that is not bundled fails at load).

### Browser (Vite + WebAssembly)

```bash
npm install @stll/anonymize-wasm
```

The wasm build exposes the same SDK surface, backed by WebAssembly. Register
the Vite plugin so the wasm binary, WASI worker, and `.stlanonpkg` assets
survive dependency pre-bundling and production builds. The `packages` option
controls which prepared packages ship (the full-dictionary default is ~20 MB,
so most apps restrict it):

```ts
// vite.config.ts
import stllAnonymizeWasm from "@stll/anonymize-wasm/vite";

export default {
  // Emit only the packages the app loads, e.g. English + Czech.
  plugins: [stllAnonymizeWasm({ packages: ["en", "cs"] })],
};
```

```ts
import { loadDefaultPipeline } from "@stll/anonymize-wasm";

const pipeline = await loadDefaultPipeline("en");
const { redaction } = pipeline.redactText("A contract signed by Jan Novák.");
console.log(redaction.redactedText);
```

The binding targets `wasm32-wasip1-threads` (shared memory), so it needs a
cross-origin-isolated (`SharedArrayBuffer`) context. See
[`packages/anonymize/wasm/README.md`](packages/anonymize/wasm/README.md) for the
full `packages` option reference.

### Python

Prebuilt wheels (available from the 2.0.0 release) bundle the native pipeline
packages, so no monorepo checkout is required.

```bash
uv add stella-anonymize-core
# or: pip install stella-anonymize-core
```

```py
import stella_anonymize as anonymize

prepared = anonymize.preload_default_native_pipeline(language="en")
result = prepared.redact_text("Contact Jan Novák at jan.novak@example.com.")

session = prepared.create_redaction_session("opaque_case_1")
session.redact_text("Jan Novák signed.")
archive = session.to_encrypted_archive(application_owned_32_byte_key)
restored = prepared.restore_encrypted_redaction_session(
    archive,
    application_owned_32_byte_key,
    "opaque_case_1",
)

print(result.redaction.redacted_text)
# Contact [PERSON_1] at [EMAIL_ADDRESS_1].
```

The Python SDK uses the same Rust core and prepared-package contract as the
Node SDK. Encrypted session archives are interoperable across those runtimes;
the application owns key generation, storage, rotation, and authorization. See
[`crates/anonymize-py/README.md`](crates/anonymize-py/README.md).

### DOCX extraction

```bash
npm install @stll/anonymize-docx
```

Use the document package to extract text without flattening away its source
structure:

```ts
import { readFile } from "node:fs/promises";
import { extractDocxText } from "@stll/anonymize-docx";

const document = await readFile("contract.docx");
const extraction = extractDocxText(document);

for (const block of extraction.blocks) {
  console.log(block.text, block.location);
}
```

Paragraph, table-cell, and text-box locations remain distinct. Headers,
footers, footnotes, endnotes, comments, hyperlinks, and tracked revisions are
represented explicitly; unsupported WordprocessingML content is reported in
`extraction.coverage` rather than silently omitted. Input size, expanded ZIP
size, entry count, and XML nesting are bounded before text is returned.
Block-local rewrite plans include the expected source text, so stale offsets fail
closed. Rewrites preserve untouched package entries and XML by content, retain
run formatting deterministically, and reject tracked-revision or digitally signed
content until an explicit policy is available.

`restoreDocxText()` accepts a live redaction session plus a mandatory expected
session ID. It restores complete known placeholders across ordinary text runs
without embedding the mapping in the DOCX; lifecycle, unknown-placeholder,
revision, signature, and structural failures remain fail-closed.

### CLI

No install needed:

```bash
echo "Contact Jan Novák at jan.novak@example.com" | bunx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]
```

Batch a directory in reversible `replace` mode, then selectively restore one
entity from the redaction key:

```bash
# Redact a document, writing the reversible key alongside it.
anonymize -k contract.key.json -o contract.anon.txt contract.txt

# Restore only the person; every other placeholder stays redacted.
anonymize -d contract.key.json --revert "[PERSON_1]" contract.anon.txt

# Recursively anonymize a tree, 8 files in flight, mirroring into out/.
anonymize --recursive --workers 8 -o out/ docs/
```

`--revert` is repeatable and matches either a placeholder token (`[PERSON_1]`)
or an original value (`Jan Novák`), case-sensitive and exact. All processing is
local; the CLI makes no network calls. Run `anonymize --help` for the full
reference, including the `--json` schema and exit codes.

## Features

- **22 default entity labels, plus 3 opt-in network labels.** People,
  organizations, addresses, countries, and land parcels; email, phone, dates, and
  dates of birth; and a family of identifiers: IBAN and bank account numbers, tax
  and national identification numbers, identity card, birth, social security,
  passport, and registration numbers, credit card numbers, crypto addresses, and
  monetary amounts. IP addresses, MAC addresses, and URLs are built in but opt-in.
  The versioned machine-readable contract is exported as `CAPABILITY_MANIFEST`
  from `@stll/anonymize/capabilities` and printed by
  `anonymize --capabilities`; scope detection to a subset with `--labels`.
- **12 languages, multi-script name corpora.** Built-in coverage for cs, de, en,
  es, fr, hu, it, pl, pt-br, ro, sk, and sv, backed by name corpora that reach
  beyond Latin script (CJK, Arabic, Thai, Korean, and romanized variants).
- **Deterministic numbered placeholders with coreference linking.** Each entity
  gets a stable `[LABEL_N]` placeholder; repeated and coreferent mentions (for
  example a defined term and its later short form) collapse to the same number,
  so the same input always yields the same output.
- **Reversible keys and selective revert.** `replace` mode emits a self-describing
  redaction key; deanonymisation restores the original text, and the CLI can
  revert a chosen subset while leaving the rest redacted.
- **Extensible detection.** Layer in your own exact-match deny lists, gazetteer
  entries, and deterministic custom regexes; caller-owned data is baked into the
  prepared package.
- **Streaming and diagnostics APIs.** Beyond `redactText`, the SDK exposes JSON,
  streaming, and per-entity diagnostics variants for pipelines that need spans,
  scores, and detection provenance.
- **Offline CLI.** Reads files or stdin, processes directories in parallel, and
  never makes a network call.

## Benchmarks

`@stll/anonymize` compared against three open-source PII libraries on a public,
synthetic, legal-domain corpus (en/cs/de: 28 documents, 196 gold entities).
Matching is span-overlap (same label, IoU >= 0.5). Full numbers, per-label
tables, and methodology live in
[`packages/benchmark`](packages/benchmark); this run is from
[`packages/benchmark/results/latest.md`](packages/benchmark/results/latest.md).

| Library    | Version | F1 (overlap, all labels) | Throughput (warm, chars/s) |
| ---------- | ------- | ------------------------ | -------------------------- |
| stella     | 2.0.0   | **83.4**                 | 907,102                    |
| presidio   | 2.2.360 | 50.9                     | 41,244                     |
| redact-pii | 3.4.0   | 31.6                     | 55,823                     |
| scrubadub  | 2.0.1   | 26.2                     | 1,563,700                  |

Per-language overlap F1 (all labels):

| Library    | cs   | de   | en   |
| ---------- | ---- | ---- | ---- |
| stella     | 77.2 | 81.6 | 90.5 |
| presidio   | 35.0 | 54.7 | 60.5 |
| redact-pii | 24.8 | 34.8 | 34.8 |
| scrubadub  | 20.3 | 31.7 | 27.6 |

Read these numbers with their caveats:

- **This is one fixture set.** The corpus is legal-domain and multilingual
  (en/cs/de), which is exactly what stella is built for and skews the comparison
  toward it. scrubadub and redact-pii are English-only; their cs/de scores are
  expected to be low and are reported as-is. The claims here are scoped to this
  benchmark, not to PII redaction in general.
- **Synthetic ground truth.** All text is public-safe synthetic legal prose with
  positionally-authored spans, so absolute numbers may differ from production
  filings. Every library sees identical inputs.
- **Competitors win in places.** Presidio leads on organizations (56.3 vs. 51.0
  F1) and on phone recall (84.6% vs. 46.2%); scrubadub and redact-pii edge email
  recall. Every label is reported, including where stella loses.

To try your own documents, `packages/benchmark` supports an `--input` mode; see
[`REPRODUCING.md`](packages/benchmark/REPRODUCING.md) for the exact toolchain,
library versions, and taxonomy-mapping decisions.

## Architecture

One Rust core (`crates/anonymize-core`) owns detection, resolution, and config
assembly. The Node.js, browser, and Python bindings are thin: they load a
prepared package, translate types, and call the same core, so they produce
identical structured output. That equivalence is enforced by cross-runtime
parity tests in CI (`python-parity.test.ts`, the native SDK contract tests, and
Rust adapter parity examples).

Dictionaries and language data are baked into `.stlanonpkg` prepared packages at
build time, not loaded from the network at runtime. Native Node binaries ship as
per-platform prebuilt sidecars (for example `@stll/anonymize-darwin-arm64`),
resolved as optional dependencies at install time. Full package graph, runtime
flow, and extension rules are in
[`packages/anonymize/ARCHITECTURE.md`](packages/anonymize/ARCHITECTURE.md).

## Determinism and privacy

- **Deterministic output.** The same input yields the same redaction on every
  run; detection is rule-driven with fixed priorities, not sampled.
- **Cross-runtime parity is tested.** CI asserts the Node and Python SDKs return
  the same structured result from the same fixtures.
- **Data stays local.** The CLI makes no network calls (stated in its `--help`);
  the SDKs load prepared packages from disk or bundled assets, and the browser
  build loads only the packages you bundle. No document text leaves the process.
- **Diagnostics APIs return raw detected text: do not log them.** The
  diagnostics and summary-diagnostics variants (`redactStaticEntitiesDiagnosticsJson`,
  `redactStaticEntitiesSummaryDiagnosticsJson`, and their per-language
  equivalents) return the full redaction result alongside the event trace, so
  the output includes `resolved_entities[].text` (the raw PII surface text)
  and `redaction.redaction_map[].original` (the original PII value), even in
  "summary" mode; the summary variant only drops the per-match/per-entity
  events from the trace, it does not strip text from the result. Detailed
  per-entity diagnostic events can also carry an optional `text` field. Treat
  every `*DiagnosticsJson` output like the source document itself: never send
  it to logs, telemetry, or any system that must not see PII. The parts that
  are safe to log are the plain redaction output (`redactedText`, the
  `placeholder`/`operator` fields of `redactionMap`/`operatorMap`, and entity
  counts you compute yourself); none of those carry original text.

## Versioning and status

Current release line: **2.0.2**. In 2.0 the product runtime moved from the in-process TypeScript pipeline to the Rust-native
SDK, and the package root now exports the native API (`getDefaultNativePipeline`
whose pipelines expose `redactText`, plus `redact_text`, `deanonymise`,
`exportRedactionKey`, and the prepared-package helpers). The 1.x
TypeScript pipeline has been removed entirely; the Rust core owns detection,
resolution, and configuration assembly across all runtimes. See
[`packages/anonymize/ARCHITECTURE.md`](packages/anonymize/ARCHITECTURE.md) and
[`packages/anonymize/CHANGELOG.md`](packages/anonymize/CHANGELOG.md) for the
package-level history.

## Packages

| Package                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `@stll/anonymize`       | Native runtime for multi-layer PII detection and anonymization |
| `@stll/anonymize-wasm`  | Browser/WASM build of the runtime                              |
| `@stll/anonymize-cli`   | Command-line anonymization (`anonymize` binary)                |
| `@stll/anonymize-data`  | Published deny-list dictionaries and trigger/config data       |
| `stella-anonymize-core` | Python bindings for the Rust anonymization core                |
| `crates/anonymize-core` | Rust anonymization core                                        |

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

### Git hooks (opt-in)

Lefthook config lives at [`lefthook.yml`](lefthook.yml) and is not
auto-installed. To enable local hooks (format on pre-commit, typecheck + format
check on pre-push):

```bash
bun run hooks:install
# bun run hooks:uninstall to remove
```

## Release hygiene

- Pinned GitHub Actions workflows validate lint, typecheck, tests, and package
  tarballs before release.
- The data package tarball is checked so every exported dictionary path is
  present.
- Release publishing is gated behind manual workflow dispatch and
  provenance-enabled npm publish steps.

## Contributing

Contributions are welcome. Run `bun run lint`, `bun run typecheck`, and
`bun run test` before opening a PR; a CLA check runs on pull requests. Please
keep language data reproducible and out of source code, and do not commit raw
personal data or non-public fixtures.

## License

Apache-2.0. See [`LICENSE`](LICENSE). Third-party runtime attributions for the browser
build are listed in
[`packages/anonymize/wasm/README.md`](packages/anonymize/wasm/README.md).
