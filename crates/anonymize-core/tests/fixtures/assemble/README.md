# Assemble parity fixtures (frozen oracles)

These fixtures are the permanent specification for the Rust static-search config
assembler (`crates/anonymize-adapter-contract/src/assemble`). Each case is a
triple:

- `<name>.input.json` — the `{ config, gazetteer }` inputs.
- `<name>.expected.json` — the assembled `BindingPreparedSearchConfig` the Rust
  assembler must reproduce (checked by `tests/assemble_parity.rs`).
- `manifest.json` — a per-fixture `packageDigest` (sha256 of the prepared
  package bytes), checked by `tests/assemble_digest.rs`.

The expected files were originally captured from the retired TypeScript
config-assembly layer. They remain **frozen oracles** during ordinary
development and CI; never regenerate them to hide an unexplained parity
failure.

An intentional oracle change requires an independent source and explicit
manual review. Never generate expected output or package digests from the Rust
assembler under test: doing so would let an implementation regression bless
itself. Do not restore a parallel TypeScript assembly implementation.
