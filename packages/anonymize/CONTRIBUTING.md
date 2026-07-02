# Contributing

Thank you for your interest in contributing to
@stll/anonymize.

## Development

```bash
bun install
bun test
```

## Adding a new detector

New detector behavior belongs in the Rust core. Do not add product detector
logic to `src/detectors/*.ts` or wire new behavior through `src/pipeline.ts`.

1. Add or update language/concept data under `packages/data/config` or
   `packages/anonymize/src/data` when the rule is data-driven.
2. Add the Rust detector or support logic under `crates/anonymize-core/src`.
3. Register detector modules through the module-owned `static_detector_rules!`
   shape described in `AGENTS.md`.
4. Add focused Rust tests and, when SDK behavior changes, TS/Python native
   parity coverage.
5. Run the native readiness/perf checks when package shape or runtime cost
   changes.

`packages/anonymize/src/legacy.ts` is temporary internal scaffolding for old
tests and migration comparisons. It is not a product extension point.

## Adding trigger phrases

Edit `config/triggers.{lang}.json` in the
@stll/anonymize-data package.

## Pull Requests

- One feature per PR
- Add tests for new functionality
