<p align="center">
  <img src=".github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

<p align="center">
  <strong>Local PII detection and anonymization for text and legal documents.</strong>
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

stella anonymize is an open-source PII redaction toolkit for applications that
need to process sensitive text locally. It is designed with contracts, court
filings, correspondence, and other legal documents in mind, while remaining a
general-purpose library.

Detection and replacement live in one Rust core. Node.js, Python, and browser
bindings call that same implementation; the repository tests their public
surfaces and normalized behavior for parity. The default pipeline is
deterministic and does not call a model or remote service.

No detector catches everything. Review coverage reports and output when a miss
would matter, especially with OCR or partially supported document formats.

## Quickstart

### Node.js

```bash
npm install @stll/anonymize
```

```ts
import { deanonymise, getDefaultNativePipeline } from "@stll/anonymize";

const pipeline = getDefaultNativePipeline({ language: "en" });
const { redaction } = pipeline.redactText(
  "Contact Alice Smith at alice@example.com.",
);

console.log(redaction.redactedText);
// Contact [PERSON_1] at [EMAIL_ADDRESS_1].

const original = deanonymise(redaction.redactedText, redaction.redactionMap);
```

Create the pipeline once and reuse it. Language-scoped packages are bundled for
English, Czech, and German; the full package covers the other supported
languages. See the [Node package guide](packages/anonymize/README.md) for
sessions, custom detections, operators, diagnostics, and prepared packages.

### Python

```bash
uv add stella-anonymize-core
# or: pip install stella-anonymize-core
```

```py
import stella_anonymize as anonymize

pipeline = anonymize.preload_default_native_pipeline(language="en")
result = pipeline.redact_text(
    "Contact Alice Smith at alice@example.com."
)

print(result.redaction.redacted_text)
```

Prebuilt wheels support Python 3.11+ on Linux, macOS, and Windows. The
[Python guide](crates/anonymize-py/README.md) covers sessions, encrypted
archives, caller detections, DOCX, and PDF APIs.

### CLI

```bash
echo "Contact Alice Smith at alice@example.com" | npx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]
```

The `anonymize` command reads stdin, files, or directory trees. It also supports
reversible keys and DOCX/PDF workflows:

```bash
anonymize -k contract.key.json -o contract.anon.txt contract.txt
anonymize -d contract.key.json contract.anon.txt
```

See the [CLI reference](packages/cli/README.md) for batch processing, selective
restoration, document commands, JSON output, and exit codes.

### Local MCP server

`@stll/anonymize-mcp` exposes path-only tools over stdio. Tool arguments contain
filesystem paths rather than document text, and results contain aggregate
status rather than document contents or plaintext mappings.

```json
{
  "mcpServers": {
    "stella-anonymize": {
      "command": "npx",
      "args": [
        "-y",
        "@stll/anonymize-mcp",
        "--root",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

The server requires Node.js 20+. It supports text, DOCX, PDF, optional encrypted
durable sessions, and provider-neutral external-detection sidecars. PDF use also
requires configured local Poppler and Tesseract executables. Read the
[MCP guide](packages/mcp/README.md) before enabling durable sessions or document
tools; it defines path, permission, key, archive, and failure boundaries.

## Document support

### DOCX

DOCX extraction, anonymization, and restoration are available in Node.js and
Python, and through the CLI and local MCP server. The adapter preserves
supported Word structure and reports anything outside its rewrite surface.
The default `require-full` policy fails closed on unsupported content; partial
rewrites require explicit opt-in.

The DOCX never stores the plaintext redaction mapping. Reversible workflows use
an application-owned session and, when persisted, an encrypted session archive.
Signed documents, tracked revisions, external relationship targets, and other
package features have explicit restrictions. See
[`@stll/anonymize-docx`](packages/document-docx/README.md) for the complete
coverage contract.

### PDF

PDF inspection is available in Node.js, Python, and WASM. Destructive PDF
anonymization is available in Node.js and Python, and through the CLI and MCP
server. The local adapter uses separately installed Poppler and Tesseract with
one explicitly selected OCR language.

The output is a new image-only PDF. Source PDF objects are not copied and black
rectangles are not layered over recoverable content. This removes
searchability, accessibility, links, forms, signatures, metadata, attachments,
and other interactive features. Verification proves the fresh output structure
and requested pixel rewrite; it cannot prove perfect OCR or PII detection
recall. The certificate therefore never claims that the output is PII-free.
See [`@stll/anonymize-pdf`](packages/document-pdf/README.md) for the inspection,
rendering, OCR, resource-limit, and verification contracts.

The full runtime and format matrix, including known gaps, lives in
[PII redaction surfaces](docs/pii-redaction-surfaces.md).

## Runtime and privacy model

- The Rust core owns detection, resolution, replacement, and document planning.
  Node.js, Python, and WASM bindings remain thin and are checked by exhaustive
  capability-profile tests.
- Prepared language data is bundled into versioned `.stlanonpkg` artifacts. The
  Node.js and Python SDKs and the CLI do not send document text over the network.
- Reversible redaction maps contain original PII. Encrypted session archives
  protect persisted mappings, but applications still own key generation,
  storage, rotation, and authorization.
- Diagnostics include raw detected text and original values, including summary
  diagnostics. Treat diagnostic output as sensitively as the input document;
  do not send it to ordinary logs or telemetry.
- External model or service detections can enter through a validated,
  digest-bound sidecar. stella does not bundle GLiNER or another model runner.

The machine-readable public contract is exported as `CAPABILITY_MANIFEST` from
`@stll/anonymize/capabilities` and printed by `anonymize --capabilities`. The
[architecture guide](packages/anonymize/ARCHITECTURE.md) describes the native
package graph and parity boundaries.

## Packages

| Package                 | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `@stll/anonymize`       | Node.js SDK and native runtime                      |
| `stella-anonymize-core` | Python bindings                                     |
| `@stll/anonymize-wasm`  | Browser/WASM runtime                                |
| `@stll/anonymize-cli`   | Command-line text, DOCX, and PDF workflows          |
| `@stll/anonymize-mcp`   | Path-only local MCP server                          |
| `@stll/anonymize-docx`  | Structure-aware DOCX adapter                        |
| `@stll/anonymize-pdf`   | PDF inspection and destructive raster anonymization |
| `@stll/anonymize-data`  | Published dictionaries and detector configuration   |
| `crates/anonymize-core` | Shared Rust core                                    |

Platform-specific Node.js binary packages are installed automatically as
optional dependencies of `@stll/anonymize`.

## Benchmarks

The benchmark package compares stella with other open-source PII tools and
normalizes several public evaluation corpora without collapsing their different
annotation semantics into one score. Evaluation-only data is kept separate
from development fixtures, and committed holdout reports contain aggregate
metrics only.

Read the [benchmark methodology](packages/benchmark/README.md), browse the
[committed aggregate results](packages/benchmark/results/), or follow the
[reproduction guide](packages/benchmark/REPRODUCING.md). Results describe
particular datasets and versions; they are not a guarantee of performance on
your documents.

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

Contributions are welcome. Please keep language-dependent data in its
per-language vocabulary, make generated data reproducible, and do not commit
raw personal data or non-public fixtures. A CLA check runs on pull requests.

## License

Apache-2.0. See [`LICENSE`](LICENSE). Third-party runtime attributions for the
browser build are listed in
[`packages/anonymize/wasm/README.md`](packages/anonymize/wasm/README.md).
