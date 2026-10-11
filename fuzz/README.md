# Fuzzing the anonymize core

Coverage-guided fuzz targets for boundary-sensitive parts of the anonymization
pipeline: artifact decoding, search normalization, and gazetteer matching.

This crate is its **own workspace** (empty `[workspace]` in `Cargo.toml`) so it
stays out of the main `--workspace` build and the strict release lints, and so
its target dependencies never touch the default build.

## Requirements

- The repository Rust 1.99.0 toolchain.
- `cargo-fuzz`: `cargo install cargo-fuzz --version 0.13.2 --locked`

## Targets

| Target            | Entry point                        | Invariant defended                                                                                                                            |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact_decode` | `SearchIndexArtifacts::from_bytes` | Any byte slice returns `Ok` or a typed `Err`, never panics / indexes OOB / slices a codepoint. Accepted input round-trips through `to_bytes`. |
| `normalize_text`  | `normalize_for_search`             | Never panics on any UTF-8; output is a fixed point (idempotent).                                                                              |
| `gazetteer_match` | assembled `PreparedEngine`         | Bounded arbitrary entries and text preserve UTF-8 and range safety, whole-word spans, and protection of synthetic opaque envelopes.           |

The gazetteer target reuses `crates/anonymize-core/tests/support/gazetteer.rs`
and `crates/anonymize-core/tests/support/gazetteer_fuzz.rs` to exercise the
assembled engine path. The integration property file calls the same driver for
stable, sanitizer-free smoke inputs. It checks the matcher’s edge rule: a
name may touch plain numeric glue and underscores, while alphabetic glue and
mixed identifier segments are rejected. Unicode Mark characters count as word
interior; scripts written without spaces do not. This is a character-level
oracle, not full Unicode segmentation. The integration property checks UAX
word boundaries for spaced Latin-name contexts where those definitions agree.
Balanced outermost `⟦...⟧` markers protect their contents. The driver
includes the same production policy source as the matcher for boundaries,
numeric glue, joined identifiers, and marker containment. Separately,
`gazetteer_reference.rs` implements a deliberately simple character-by-character
reference without production helpers or marker indexes. Every fuzz run compares
both predicates at every single-character span, including rejected spans;
generated properties compare arbitrary UTF-8 spans and exhaustively probe
synthetic boundary, identifier, and marker cases. No policy exceptions are
excluded. Template placeholders retain main's entry-spelling exception:
raw predicate comparisons omit spelling evidence, while emitted-name checks
allow a template field only when its surface shows a name. Mutation witnesses reject a one-byte edge shift and a skipped
identifier check. Arbitrary caller entries may match normalized full
identifiers or eligible subsegments (for example `a1b2` before the plain `dead`
segment in `a1b2-dead-c3d4`). Independently, the injected short `dead` seed must
never match its protected occurrences, and a manufactured plain term must be
found on every run. Fixtures use synthetic strings.

Input is bounded to 768 bytes: the first four newline-separated fields become
entries (up to 40 characters each; empty and marker-bearing literals are skipped),
and the remaining fields form host text (up to 512 characters).

## Running

From this directory, run coverage-guided fuzzing on the pinned stable toolchain
with sanitizers disabled:

```sh
cargo fuzz run artifact_decode --sanitizer none -- -max_total_time=10
cargo fuzz run normalize_text --sanitizer none -- -max_total_time=30
cargo fuzz run gazetteer_match --sanitizer none -- -max_total_time=30

# Longer campaign:
cargo fuzz run artifact_decode --sanitizer none -- -max_total_time=600
```

The stable code-generation options retain coverage instrumentation. CI smoke-runs
all three targets with `--sanitizer none` and a bounded run count.

List targets with `cargo fuzz list`. Crashes land in
`artifacts/<target>/`; reproduce with:

```sh
cargo fuzz run artifact_decode --sanitizer none artifacts/artifact_decode/<crash-file>
```

Discovered corpus lives in `corpus/<target>/`. These outputs are git-ignored;
commit a minimized reproducer through the shared property-test drivers instead
of the raw corpus. Deterministic generated inputs remain available through:

```sh
cargo test --manifest-path ../Cargo.toml -p stella-anonymize-core --test gazetteer_properties
cargo test --manifest-path ../Cargo.toml -p stella-anonymize-core --test primitives_properties
```

## Adding a target

1. Add `fuzz_targets/<name>.rs` with a `fuzz_target!` closure over `&[u8]`.
2. Register a `[[bin]]` entry in `Cargo.toml`.
3. Assert an invariant (round-trip, idempotence, bounds), not just "does not
   panic" — libFuzzer already catches panics for free, so an extra `assert!`
   is where the real coverage comes from.
