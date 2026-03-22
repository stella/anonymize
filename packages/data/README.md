<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/anonymize-data

Deny-list dictionaries and configuration data for
[@stll/anonymize](https://github.com/stella/anonymize).

## Contents

### Config (21 files)

Trigger phrases, name corpora, legal forms, honorifics,
coreference patterns, stopwords, and address boundaries
across 10+ languages.

### Dictionaries (315+ files)

- **Banks** — SWIFT/BIC codes per country
- **Cities** — city names per country
- **Streets** — street type keywords per language
- **Country names** — translations across EU languages

## Install

```bash
npm install @stll/anonymize-data
```

## Usage

Used as a peer dependency of `@stll/anonymize`.
Import config or dictionary files directly:

```typescript
import triggers from '@stll/anonymize-data/config/triggers.cs.json'
import cities from '@stll/anonymize-data/dictionaries/cities/CZ.json'
```

## License

MIT
