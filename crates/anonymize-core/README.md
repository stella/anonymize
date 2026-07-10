# stella-anonymize-core

Rust core for stella anonymization. Host-language packages should stay thin:
they translate types, load artifacts, and call this crate.

For package-level architecture, SDK boundaries, and prepared package flow, see
[`packages/anonymize/ARCHITECTURE.md`](../../packages/anonymize/ARCHITECTURE.md).

## Public Shape

- `PreparedEngine` is the prepared anonymization engine.
- Prefer the bon constructor for new code:

```rust
let engine = PreparedEngine::prepare().config(config).call()?;
```

With prebuilt artifacts:

```rust
let artifacts = PreparedEngine::prepare_artifacts(config.clone())?;
let view = artifacts.as_view();
let engine = PreparedEngine::prepare()
  .config(config)
  .artifacts(&view)
  .call()?;
```

Caller-produced detections enter the same resolution and redaction pipeline.
Offsets are UTF-8 byte offsets; matched text is derived from the document so a
caller cannot supply text that disagrees with the span:

```rust
let detections = vec![CallerDetection::new(CallerDetectionParams {
  start: 0,
  end: 5,
  label: String::from("person"),
  score: 0.95,
})?];
let result = engine.redact_static_entities_with_caller_detections(
  "Alice signed.",
  CallerRedactionOptions {
    operators: &OperatorConfig::default(),
    detections: &detections,
  },
)?;
```

## Pipeline Layout

- `prepare_phase.rs`: validates config, loads artifacts, prepares indexes and support data.
- `search_phase.rs`: runs byte-safe search branches and records search diagnostics.
- `detection_phase.rs`: turns matches into candidate entities through the static detector registry.
- `resolution_phase.rs`: applies hotwords, zones, coreference, merge, boundary, and sanitize passes.
- `redaction_phase.rs`: builds final replacements and redaction maps.
- `diagnostics.rs`: owns stable diagnostic phases, stages, and event shape.

Keep domain data out of Rust code. Dictionaries, language rules, fixtures, and
generated artifacts belong in reproducible data files organized by language and
concept.

## Tests

- `tests/diagnostics.rs`: diagnostic phases, stage summaries, streaming batches.
- `tests/builders.rs`: bon builders and public constructor shape.
- `tests/prepared.rs`: end-to-end prepared-engine behavior.
- `tests/primitives_properties.rs`: property coverage for artifact/search invariants.
- `tests/snapshots/`: reviewable `insta` snapshots for stable diagnostics and redaction summaries.

Snapshot tests should serialize stable summaries, not volatile timings. Avoid
snapshotting sensitive raw fixture text; use small public fixtures or normalized
summaries with labels, spans, counts, and redacted output.

Useful local checks:

```bash
cargo fmt --all --check
cargo clippy -p stella-anonymize-core --all-targets --all-features -- -D warnings
cargo test -p stella-anonymize-core --all-features
```

Snapshot workflow:

```bash
cargo insta test -p stella-anonymize-core --all-features
cargo insta accept
```

If `cargo-insta` is not installed, generate snapshots with:

```bash
INSTA_UPDATE=always cargo test -p stella-anonymize-core --all-features
```
