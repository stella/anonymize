<p align="center">
  <img src=".github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

# anonymize

Monorepo for the stella anonymization stack.

It contains the runtime package, the published data package, and the browser/WASM entrypoint used by downstream apps.

## Packages

| Package                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `@stll/anonymize`       | Native runtime for multi-layer PII detection and anonymization |
| `@stll/anonymize-data`  | Published deny-list dictionaries and trigger/config data       |
| `@stll/anonymize-wasm`  | Browser/WASM build of the runtime                              |
| `@stll/anonymize-cli`   | Command-line anonymization (`anonymize` binary)                |
| `stella-anonymize-core` | Rust anonymization core                                        |
| `stella-anonymize-py`   | Python bindings for the Rust anonymization core                |

## Install

```bash
bun add @stll/anonymize
# Optional runtime data bundle
bun add @stll/anonymize-data
# Browser / Vite usage
bun add @stll/anonymize-wasm
# Python SDK (activates with the next release)
uv add stella-anonymize-core
```

Or anonymize from the terminal without installing:

```bash
echo "Contact Jan Novák at jan.novak@example.com" | bunx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]
```

## What it does

- Regex-based detection for common identifiers, dates, and legal entities
- Trigger phrases and deny-list matching for language-aware anonymization
- NER, coreference handling, and confidence boosting
- Native, browser, and Vite-compatible entrypoints

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

### Git hooks (opt-in)

Lefthook config lives at [`lefthook.yml`](lefthook.yml) and is not auto-installed. To enable local hooks (format on pre-commit, typecheck + format check on pre-push):

```bash
bun run hooks:install
# bun run hooks:uninstall to remove
```

## Release hygiene

- Pinned GitHub Actions workflows validate lint, typecheck, tests, and package tarballs before release.
- The data package tarball is checked to make sure every exported dictionary path is present.
- Release publishing is gated behind manual workflow dispatch and provenance-enabled npm publish steps.

## Repository layout

- [`packages/anonymize`](packages/anonymize)
- [`packages/data`](packages/data)
- [`packages/anonymize/wasm`](packages/anonymize/wasm)
- [`crates/anonymize-core`](crates/anonymize-core)
- [`crates/anonymize-py`](crates/anonymize-py)

Architecture notes for the native runtime live in
[`packages/anonymize/ARCHITECTURE.md`](packages/anonymize/ARCHITECTURE.md).
