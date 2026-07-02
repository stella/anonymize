# @stll/anonymize Architecture

`@stll/anonymize` is Rust-native. The TypeScript and Python SDKs translate
types, load prepared packages, and call the same Rust core.

## Package Graph

- `crates/anonymize-core`: anonymization logic, detectors, resolution, redaction,
  diagnostics, and prepared artifact loading.
- `crates/anonymize-adapter-contract`: shared JSON/package contract used by
  host-language bindings.
- `crates/anonymize-napi`: Node.js binding.
- `crates/anonymize-py`: Python binding.
- `packages/anonymize/src/native.ts`: binding-agnostic TypeScript SDK wrappers.
- `packages/anonymize/src/native-node.ts`: Node.js binding loader and default
  prepared-package loader.
- `packages/anonymize/src/native-pipeline.ts`: build-time/package-time adapter
  from TypeScript config/data files into the Rust prepared package contract.
- `packages/anonymize/src/legacy.ts`: temporary internal TypeScript pipeline
  entrypoint for old tests and migration comparisons. It is not exported from
  `package.json` and should not be used for product features.

## Native Distribution

`@stll/anonymize` is the platform-neutral runtime package. Native Node binaries
ship through exact-version optional sidecars such as
`@stll/anonymize-darwin-arm64` and `@stll/anonymize-linux-x64-gnu`. The root
package must not publish a `.node` file; release publishes sidecars before the
root package so npm can resolve the optional dependency at install time.

Keep sidecar package names, package metadata, exact optional dependency pins,
and release matrix entries aligned through
`.github/tools/check-native-sidecars.mjs`.

## Runtime Flow

1. Build or load a `.stlanonpkg` prepared package.
2. Create a `PreparedNativePipeline` from package bytes.
3. Optionally call `warmLazyRegex()` during service startup.
4. Call `redactText()`, `redactTextJson()`, diagnostics, or stream helpers.

The default product path ships an all-language package plus optional scoped
language packages. When a caller knows the document language, use
`getDefaultNativePipeline({ language })` so the runtime uses the smaller scoped
artifact when available.

## Rust Core Flow

The Rust prepared engine is split by phase:

- `prepare_phase.rs`: validate config, load artifacts, build indexes/support data.
- `search_phase.rs`: run byte-safe search branches.
- `detection_phase.rs`: run the static detector registry.
- `resolution_phase.rs`: apply context, hotwords, merge, boundary, sanitize.
- `redaction_phase.rs`: build replacements and maps.

Detector modules live under `crates/anonymize-core/src/prepared/detectors`.
Adding a detector should mean adding module-local rule metadata and detection
logic through `static_detector_rules!`; the registry only preserves module order.
Prepared support resources are declared once in `support_resources.rs`; prepare
timing, detector input checks, and snapshots derive from that declaration where
the resource-specific data type still allows it.
The detector registry and support-resource contracts are snapshot-tested, so
changes to ids, stages, inputs, dependencies, and required prepared data produce
reviewable diffs.

## Extension Rules

- Add vocabulary and language data in data files, organized by language and
  concept.
- Add detector behavior in Rust, with focused Rust tests.
- Keep TypeScript and Python wrappers thin; do not duplicate business logic in
  bindings.
- Keep legacy TypeScript pipeline changes limited to temporary parity work.

## Review Checklist

- Does the change affect prepared package bytes, runtime execution, or both?
- Does the package remain loadable by Node and Python SDKs?
- Are TS/Python/Rust fixture outputs still aligned through native SDK tests?
- Are cold start, warm run, package load, prepare, and execution measured
  separately when performance changes?
- Is raw input text kept out of logs and snapshots?
