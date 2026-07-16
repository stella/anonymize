# Changelog

## Unreleased

## 2.0.2 (2026-07-16)

### Features

- Publish a versioned capability manifest and accept validated caller-supplied
  detections through the shared resolution and redaction pipeline across Node,
  browser WASM, and Python, with audit-safe provenance diagnostics.
- Add `keep` and configurable Unicode-grapheme-safe `mask` operators across all
  runtimes.
- Add stable cross-document redaction sessions with lifecycle controls,
  deterministic placeholders, restoration, and bounded authenticated encrypted
  archives across Rust, Node, browser WASM, and Python.
- Publish `@stll/anonymize-docx` with bounded structure-aware extraction,
  formatting-preserving rewrites, session-backed restoration, scriptable
  anonymization, explicit coverage policies, and aggregate audit-safe summaries.
- Add encrypted DOCX anonymize and restore CLI workflows with atomic no-clobber
  outputs and serialized session continuation.

### Fixes

- Preserve placeholder namespaces during DOCX restoration and reject unsupported
  or incomplete restoration coverage instead of silently skipping content.
- Keep benchmark detector assets reproducible without the removed vulnerable
  runtime dependency tree.

## 2.0.1 (2026-07-07)

### Features

- Export the config-driven pipeline surface from `@stll/anonymize-wasm`: `prepareNativePipelineConfig`, `createNativePipelineFromConfig`, `prepareNativePipelinePackage`, `assertNativePipelineSupported`, `getNativePipelineCompatibility`, `createPipelineContext`, and the `PipelineConfig` / `Dictionaries` / `GazetteerEntry` types. Browsers can now assemble prepared packages from a `PipelineConfig` at runtime instead of only loading prebuilt packages.

## 2.0.0 (2026-07-07)

### Breaking changes

- The TypeScript detection pipeline is replaced by a Rust core (`stella-anonymize-core`) exposed through napi (Node), WebAssembly (browser), and Python bindings. `runPipeline`, `preparePipelineSearch`, and the old config-in/entities-out surface are removed; detection and redaction now happen in one combined call on a prepared pipeline (`PreparedNativePipeline.redactText`), which returns resolved entities together with the redaction result.
- `PipelineContext` no longer carries coreference or placeholder-counter state across calls; batch related passes into a single redact call for consistent placeholder numbering.
- `RedactionResult` gains a required `operatorMap` field (placeholder → operator).
- Browsers load prepared `.stlanonpkg` packages; scoped per-language packages (`en`, `cs`, `de`) ship with the npm tarballs and `getDefaultNativePipeline({ language })` selects them.

### Features

- Prebuilt Python wheels (`stella-anonymize-core`) published to PyPI for Linux (x64/arm64), macOS (x64/arm64), and Windows, bundling the native pipeline packages.
- Native platform sidecar packages for Node (darwin-arm64/x64, linux-x64/arm64-gnu, win32-x64-msvc) installed via `optionalDependencies`.
- CLI: directory batch mode and selective revert from a redaction key.
- Deterministic, offline redaction: same document, same output, in every runtime.

## 1.4.9 (2026-06-11)

### Features

- Windows x64 support: require `@stll/text-search` >=1.0.6, whose native engines now ship `win32-x64-msvc` bindings. `@stll/anonymize` loads natively on Windows.

## 1.4.1 (2026-05-15)

### Fixes

- Capture legal-form organization names with internal commas, single-letter party names, dotted firm initials, ampersands, and comma-separated suffixes.
- Keep structural schedule/article/exhibit labels and ordinary sentence-final words out of legal-form organization matches.
- Move financial magnitude and share-quantity lexicons into language data while avoiding ambiguous global suffix false positives.
- Document the runtime package more clearly for install and browser usage.
- Keep the data package peer dependency aligned with the published data surface.

## 0.0.1 (2026-03-22)

### Features

- Multi-layer PII detection pipeline
- Regex detector (IBAN, email, phone, dates, IDs)
- Trigger phrase detector (10 languages)
- Legal form detector (20+ countries)
- Name corpus with Czech/Slovak declension
- GLiNER zero-shot NER integration
- Aho-Corasick + fuzzy deny-list gazetteer
- Coreference resolution (defined-term tracking)
- Confidence boosting and false positive filtering
- Replace and redact operators
- De-anonymization support
