## Repository Specifics

This is a Bun-first TypeScript monorepo for text anonymization. The library handles sensitive text, so privacy, deterministic behavior, and clear data boundaries matter.

### Commands

- `bun install`
- `bun run lint`
- `bun run format:check`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run check:version`

### Working Rules

- Do not log raw input text, extracted entities, or full anonymization fixtures unless the fixture is intentionally public and minimal.
- Keep dictionary and data changes reproducible and easy to diff.
- Favor invariant tests around redaction stability, offsets, and replacement safety over snapshot-only examples.
- Start architecture reviews from `packages/anonymize/ARCHITECTURE.md`; it
  explains the native package graph, prepared-package flow, and temporary legacy
  test boundary.

### Native Detector Shape

Rust static detectors should follow the module-owned rule shape. A detector
module declares its metadata and hooks in one `static_detector_rules!` block,
then keeps the activation predicate and detection implementation next to it:

```rust
static_detector_rules! {
  pub(in crate::prepared) const RULES;
  EXAMPLE_RULE {
    id: DetectorId::Example;
    stage: DiagnosticStage::EntityExample;
    inputs: &[DetectorInput::FullText];
    uses: &[SupportResource::Example];
    active: example_is_active;
    detect: detect_example;
  }
}
```

The central detector registry should only list detector modules and preserve
cross-module execution order. Avoid adding detector-specific branching,
diagnostic-stage mapping, or activation logic outside the detector module.
Brand-new detector concepts may still require adding a detector id, input, or
support resource, but the rule metadata and behavior stay module-local.
