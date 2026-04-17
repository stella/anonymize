# Contributing

Thank you for your interest in contributing to
@stll/anonymize.

## Development

```bash
bun install
bun test
```

## Adding a new detector

1. Create `src/detectors/your-detector.ts`
2. Export a function returning `Entity[]`
3. Wire it into `src/pipeline.ts`
4. Add tests

## Adding trigger phrases

Edit `config/triggers.{lang}.json` in the
@stll/anonymize-data package.

## Pull Requests

- One feature per PR
- Add tests for new functionality
