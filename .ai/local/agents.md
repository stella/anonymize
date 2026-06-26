## Repository Specifics

This is a Bun-first TypeScript monorepo for text anonymization. The library handles sensitive text, so privacy, deterministic behavior, and clear data boundaries matter.

> Cargo build artifacts go to `E:\cargo-target\anonymize` (configured in `.cargo/config.toml`).

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
