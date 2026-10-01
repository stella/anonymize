# Fuzzing the anonymize core

Coverage-guided fuzz targets for boundary-sensitive parts of the anonymization
pipeline: artifact decoding, search normalization, and gazetteer matching.

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
Arbitrary `⟦...⟧` spans are protected,
and manufactured identifier compounds are protected as subranges inside URL,
email, UUID, hex, underscore, and bracketed contexts; ordinary URL/domain and
email text remains eligible. A manufactured plain term must be found on every
run. Caller-specified identifiers may match exactly in full; partial overlaps
remain invalid. Fixtures use synthetic strings.

Input is bounded to 768 bytes: the first four newline-separated fields become
entries (up to 40 characters each), and the remaining fields form host text
(up to 512 characters).

## Running

```sh
# From this directory. Short local smoke run:
cargo +nightly fuzz run artifact_decode -- -max_total_time=30

# Longer campaign:
cargo +nightly fuzz run normalize_text -- -max_total_time=600

# Gazetteer spans stay bounded, whole-word, and outside synthetic opaque tokens.
cargo +nightly fuzz run gazetteer_match -- -max_total_time=600
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
