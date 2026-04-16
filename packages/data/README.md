<p align="center">
  <img src="../../.github/assets/banner.png" alt="Stella anonymize" width="100%" />
</p>

# @stll/anonymize-data

Published configuration data and dictionary catalogs for `@stll/anonymize`.

This package is the stable data surface for the runtime package. It exists so the runtime can stay focused on detection logic while the published deny-list and trigger assets remain versioned separately.

## What ships

- `config/` for trigger, stopword, legal form, and coreference configuration
- `dictionaries/names/` for first names, surnames, titles, and global fallback lists
- `dictionaries/cities/` for country-specific city corpora
- `dictionaries/banks/`, `dictionaries/courts/`, `dictionaries/insurance/`, `dictionaries/education/`, `dictionaries/government/`, `dictionaries/healthcare/`, and `dictionaries/international/` for organization and institution deny-lists

## Install

```bash
bun add @stll/anonymize-data
```

## Usage

```ts
import triggers from "@stll/anonymize-data/config/triggers.cs.json";
import cities from "@stll/anonymize-data/dictionaries/cities/CZ.json";
import banks from "@stll/anonymize-data/dictionaries/banks/US.json";
```

## Maintenance

- The package build checks trigger configs for schema mistakes and duplicate trigger collisions.
- The npm tarball is expected to contain every exported dictionary path listed in `package.json`.
- Release automation should validate the packed file list before anything is published.
