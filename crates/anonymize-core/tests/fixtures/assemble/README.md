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

For an intentional assembler or bundled-data behavior change, use the ignored
Rust updater with both safety gates and an explicit comma-separated allowlist:

```sh
STELLA_UPDATE_ASSEMBLE_FIXTURES=1 \
STELLA_ASSEMBLE_FIXTURES=baseline-all-on,language-all \
cargo test -p stella-anonymize-core --test assemble_regenerate -- --ignored
```

The updater changes only the selected expected outputs and their manifest
digests, then applies the repository's standard JSON formatter. Review the
generated diff and commit it with the behavior change. Do not restore a
parallel TypeScript assembly implementation.
