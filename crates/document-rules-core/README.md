# Structured document rules

`stella-document-rules-core` is a neutral Rust foundation for rules that run
over ordered document blocks. It owns no file-format parser, vocabulary, model,
network client, or host runtime.

The public model provides stable block IDs, bounded metadata, block-local byte
spans, typed finding kinds and actions, and three rule scopes:

- `Block` for local analysis;
- `Neighborhood(radius)` for an explicitly bounded window;
- `DocumentFacts` for derived document-wide facts.

Rules implement `DocumentRule` and are assembled into a `RuleSet`. Every rule
receives the shared `BlockAnalysis` produced by the engine rather than building
its own token or boundary map.

## Execution modes

`RuleEngine::analyze` is the direct one-shot path. It executes the shared rule
kernels without constructing an incremental database.

`IncrementalDocumentSession` adds revisioned patches and Salsa-backed caching.
The `incremental` Cargo feature is enabled by default; batch-only consumers can
disable default features to omit Salsa entirely:

```toml
stella-document-rules-core = { path = "...", default-features = false }
```

Incremental inputs keep block content, metadata, order, and declared
neighborhood links separate. An edit therefore invalidates only the queries
that declared a dependency on the changed input. Deterministic counter tests
enforce this bound, while parity tests require batch and incremental findings
to remain exactly equal.

The crate forbids unsafe code and checks on `wasm32-unknown-unknown`. Static
Rust rule sets can therefore use the same direct or incremental kernels in a
single-thread browser WebAssembly build.
