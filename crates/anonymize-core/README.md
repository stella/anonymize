# stella-anonymize-core

Rust core for stella anonymization. Host-language packages should stay thin:
they translate types, load artifacts, and call this crate.

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

Useful local checks:

```bash
cargo fmt --all --check
cargo clippy -p stella-anonymize-core --all-targets --all-features -- -D warnings
cargo test -p stella-anonymize-core --all-features
```
