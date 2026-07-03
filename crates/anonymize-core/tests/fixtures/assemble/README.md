# Assemble parity fixtures (frozen oracles)

These fixtures are the permanent specification for the Rust static-search config
assembler (`crates/anonymize-adapter-contract/src/assemble`). Each case is a
triple:

- `<name>.input.json` — the `{ config, gazetteer }` inputs.
- `<name>.expected.json` — the assembled `BindingPreparedSearchConfig` the Rust
  assembler must reproduce (checked by `tests/assemble_parity.rs`).
- `manifest.json` — a per-fixture `packageDigest` (sha256 of the prepared
  package bytes), checked by `tests/assemble_digest.rs`.

They were captured once from the retired TypeScript config-assembly layer
(`packages/anonymize/src/build-unified-search.ts` and its detector modules)
before that layer was deleted in the Rust-assembler cutover. That capture script
(`packages/anonymize/scripts/capture-assemble-fixtures.mjs`) is gone along with
the TypeScript source it depended on, so these files are **frozen** — they are
the oracle, not a regenerated artifact.

Do not "recapture" them. If a fixture's expected output must change, the change
is a deliberate behavior change to the assembler: update the expected/manifest
values by hand (or from the Rust assembler output) in the same commit that
changes the assembler, and explain why in the commit message.
