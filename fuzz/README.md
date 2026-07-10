# Fuzzing the anonymize core

Coverage-guided fuzz targets for the boundary-sensitive parts of
`stella-anonymize-core`: the artifact decoder and search normalization. These
are the surfaces that take adversarial bytes or text and do offset / codepoint
math, so a regression there is exactly the class of bug examples miss.

This crate is its **own workspace** (empty `[workspace]` in `Cargo.toml`) so it
stays out of the main `--workspace` build and the strict release lints, and so
its nightly-only sanitizer dependencies never touch the default build.

## Requirements

- A nightly toolchain (already vendored for dylint):
  `nightly-2026-04-16` or plain `nightly`.
- `cargo-fuzz`: `cargo install cargo-fuzz --locked`

## Targets

| Target            | Entry point                        | Invariant defended                                                                                                                            |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact_decode` | `SearchIndexArtifacts::from_bytes` | Any byte slice returns `Ok` or a typed `Err`, never panics / indexes OOB / slices a codepoint. Accepted input round-trips through `to_bytes`. |
| `normalize_text`  | `normalize_for_search`             | Never panics on any UTF-8; output is a fixed point (idempotent).                                                                              |

## Running

```sh
# From this directory. Short local smoke run:
cargo +nightly fuzz run artifact_decode -- -max_total_time=30

# Longer campaign:
cargo +nightly fuzz run normalize_text -- -max_total_time=600
```

List targets with `cargo +nightly fuzz list`.

Crashes land in `fuzz/artifacts/<target>/`; reproduce with
`cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<crash-file>`.
Discovered corpus lives in `fuzz/corpus/<target>/`. Both directories are
git-ignored (see `.gitignore`); commit a minimized reproducer as a regression
test in `crates/anonymize-core/tests/` instead of the raw corpus.

## Adding a target

1. Add `fuzz_targets/<name>.rs` with a `fuzz_target!` closure over `&[u8]`.
2. Register a `[[bin]]` entry in `Cargo.toml`.
3. Assert an invariant (round-trip, idempotence, bounds), not just "does not
   panic" — libFuzzer already catches panics for free, so an extra `assert!`
   is where the real coverage comes from.
