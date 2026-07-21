# Changelog

## 2.3.0

### Minor Changes

- [#325](https://github.com/stella/anonymize/pull/325) [`6ae6b7b`](https://github.com/stella/anonymize/commit/6ae6b7bf6107d221e2d00e6ab9bddd464637920d) Thanks [@berticeek](https://github.com/berticeek)! - Detect more identifier types across languages: international court case numbers (ECLI, UK neutral citations, US docket numbers), additional German phone formats and tax IDs, Hungarian personal numbers, SWIFT/BIC codes, and US ZIP codes, plus keyword triggers for passport numbers, company-registration numbers, and Czech land-parcel and reference numbers.

- [#306](https://github.com/stella/anonymize/pull/306) [`dab5a5d`](https://github.com/stella/anonymize/commit/dab5a5d0b2855e0684ceac8d0d70e5ebc5ac234f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish versioned runtime parity profiles and public capability surfaces in the capability manifest, with CI gates for Node.js, Python, WASM, and DOCX adapters. Add bounded DOCX extraction, rewrite, transactional anonymization, and restoration to the Python binding.

### Patch Changes

- [#321](https://github.com/stella/anonymize/pull/321) [`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect day-month dates without a year while rejecting invalid calendar days
  and keeping lowercase month ambiguities scoped to their language vocabulary.

- [#318](https://github.com/stella/anonymize/pull/318) [`f74669b`](https://github.com/stella/anonymize/commit/f74669ba7ca7611d22baaafd71251e8bb39c734b) Thanks [@cursor](https://github.com/apps/cursor)! - Keep Attn notice-block people intact when given names are missing from the scoped English corpus and when middle-initial counsel names overlap US city tokens.

- [#303](https://github.com/stella/anonymize/pull/303) [`d8d415b`](https://github.com/stella/anonymize/commit/d8d415b73081aac38ca5d3b190a237e372d3a557) Thanks [@cursor](https://github.com/apps/cursor)! - Keep dotted middle initials inside EDGAR person spans for honorific notice names, deny-list given+surname extension, and dual `/s/` signatures on one line.

- [#323](https://github.com/stella/anonymize/pull/323) [`9683503`](https://github.com/stella/anonymize/commit/96835036dd4c47d246d4237d9e7476c9d58b9e2a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect named courts, agencies, ministries, offices, law firms, and other institutional organizations without requiring a corporate legal-form suffix.

- [#302](https://github.com/stella/anonymize/pull/302) [`b4d8986`](https://github.com/stella/anonymize/commit/b4d89868988c467d20e6d5f5a860235e04464a95) Thanks [@cursor](https://github.com/apps/cursor)! - Classify person-shaped values after organization-labelled party-role triggers from the shared vocabulary as people, while keeping institutions and legal-form companies as organizations.

- [#317](https://github.com/stella/anonymize/pull/317) [`4016556`](https://github.com/stella/anonymize/commit/4016556b0d63d3e534722ac2e8e8eb1023a6cd1a) Thanks [@cursor](https://github.com/apps/cursor)! - Stop person spans at signature-stamp phrases and colon-tied form-field labels. The vocabulary is language-keyed data in `signature-detection.json` and is applied once, in the resolution boundary pass, instead of per detector.

- [#312](https://github.com/stella/anonymize/pull/312) [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route Node and Python DOCX extraction through one bounded Rust core, with archive-wide fail-fast budgets and fail-closed package inventory.

- [#314](https://github.com/stella/anonymize/pull/314) [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route DOCX restoration planning through the shared Rust core while preserving stable Node and Python error categories.

- [#313](https://github.com/stella/anonymize/pull/313) [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route Node and Python DOCX rewriting through the shared bounded Rust core while preserving stable adapter contracts.

## 2.2.0

### Minor Changes

- [#295](https://github.com/stella/anonymize/pull/295) [`956d098`](https://github.com/stella/anonymize/commit/956d0989dcd51fd7a45c36076813392112a6bfb6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Migrate the prepared-package payload codec from the unmaintained `bincode` (RUSTSEC-2025-0141) to `postcard`, and bump every `.stlanonpkg` format version. Packages built by earlier releases are rejected with the typed "unsupported version" error; rebuild persisted packages with `stella-anonymize-build-native-package` or `prepareNativePipelinePackage` after upgrading. The bundled default packages are rebuilt automatically at release time, so callers using `getDefaultNativePipeline` are unaffected.

- [#293](https://github.com/stella/anonymize/pull/293) [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove the deprecated `PipelineConfig.enableNer` field. The native pipeline never implemented NER and always rejected `true`; typed callers that still pass `enableNer: false` should delete the line. Untyped callers that pass `enableNer: true` keep failing fast through `assertNativePipelineSupported`. Configs serialized with the old field (existing prepared packages) continue to load; the stale key is ignored.

### Patch Changes

- [#296](https://github.com/stella/anonymize/pull/296) [`eeef356`](https://github.com/stella/anonymize/commit/eeef356715307cda6c0c5e425c5fc9f3e0a317bb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bound regex backtracking in trigger matching. Configuration-supplied
  `match-pattern` trigger patterns are now built through a single wrapper that
  prefers the linear-time `regex` engine and only falls back to `fancy_regex`
  (with an explicit backtrack limit) for patterns that genuinely need lookaround
  or backreferences. A pathological pattern/input pair now fails with a typed
  error instead of consuming unbounded CPU, closing a ReDoS vector; ordinary
  patterns match identically.

- [#292](https://github.com/stella/anonymize/pull/292) [`39f4deb`](https://github.com/stella/anonymize/commit/39f4deb5f6011d8953585ff3656c53058dc13f73) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove unused runtime dependencies (`@huggingface/tokenizers`, `@stll/stdnum`, `@stll/text-search`) left over from the removed TypeScript detection pipeline. ID validation, search, and tokenization live in the Rust core; these packages were no longer imported anywhere but still installed for every consumer.

- [#301](https://github.com/stella/anonymize/pull/301) [`9f53741`](https://github.com/stella/anonymize/commit/9f53741e4ca9d847097fa342fecb2693b6e3a091) Thanks [@cursor](https://github.com/apps/cursor)! - Detect dictionary-backed and Czech feminine surnames written in uppercase,
  including in compacted native packages.

- [#300](https://github.com/stella/anonymize/pull/300) [`d6a8fd9`](https://github.com/stella/anonymize/commit/d6a8fd9fa2d096423afbcd7e0f558bfee17840bb) Thanks [@cursor](https://github.com/apps/cursor)! - Improve EDGAR contract person recall and precision: reject person-name fragments inside hyphen compounds such as the "Frank" in "Dodd-Frank" (while keeping hyphenated place names), stop attaching generational Roman numerals as city districts after a personal-name prefix, reject street-containing statute titles as addresses, and add English name-corpus entries for common notice-block contacts.

- [#291](https://github.com/stella/anonymize/pull/291) [`33c533a`](https://github.com/stella/anonymize/commit/33c533a60a4937213e557aec05c37d11f4d78731) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Improve English person recall for counsel names in notice blocks, reject allow-listed single-token person triggers such as "Shares", and soft-wrap jurisdiction phrases across a single line break.

- [#288](https://github.com/stella/anonymize/pull/288) [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bound the previously unbounded default-pipeline and shared prepared-package
  caches with LRU eviction, and normalize the default-pipeline cache key so
  locale aliases that resolve to the same bundled package no longer each retain a
  distinct entry. Prevents attacker/user-varyable language tags, custom deny
  lists, regexes, or gazetteer data from growing process memory without limit.

- [#288](https://github.com/stella/anonymize/pull/288) [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Fix PII false-negative regressions and hardening in the Rust detection core.
  Overlap resolution is now width-aware so caller-supplied and custom detections
  are not silently overridden by smaller built-in spans (and a narrow custom span
  no longer evicts the wider built-in it sits inside), with a symmetric guard that
  keeps a country nested in an address from clobbering the address. Legal-form
  detection recovers organizations after dotted abbreviations and across
  connectors and keeps digit-led names. Trigger detection adds missing name
  particles, stops mis-capping line-delimited and long comma-terminated values,
  accepts dot-space phone separators, and treats slash dates as non-phone padding.
  Name and deny-list handling stops discarding global-corpus names, allow-listed
  single-word organization aliases, and lowercase street addresses, and stops a
  cross-language stopword collision from suppressing a real single-token name.
  Raw native package payloads are size-checked before digest verification and
  decoding.

## 2.1.0

### Minor Changes

- [#285](https://github.com/stella/anonymize/pull/285) [`a427007`](https://github.com/stella/anonymize/commit/a427007925e7f1cf6c74e1796cd4e622affd0250) Thanks [@berticeek](https://github.com/berticeek)! - Add Python bindings for `deanonymise()`

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
