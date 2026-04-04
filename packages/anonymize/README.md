<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

# @stll/anonymize

Multi-layer PII detection and anonymization pipeline.
Regex, NER, deny lists, coreference resolution, and
legal form detection across 20+ languages.

## Features

- **Regex detector** — IBAN, email, phone, credit card,
  Czech birth numbers, dates (22 languages), company IDs
- **Trigger phrases** — Czech, German, English, French,
  Spanish, Italian, Polish, Hungarian, Romanian, Swedish
- **Name corpus** — first names, surnames, titles with
  Czech/Slovak declension handling
- **Legal form detection** — s.r.o., GmbH, Ltd., S.A.,
  and 1000+ forms across 20+ countries
- **GLiNER NER** — zero-shot named entity recognition
- **Deny-list gazetteer** — workspace-scoped Aho-Corasick
  + fuzzy matching
- **Coreference** — tracks "dále jen" / "hereinafter"
  aliases with Czech declension variants
- **Confidence boosting** — context-aware score adjustment
- **False positive filtering** — template placeholders,
  section numbers, generic roles
- **Operators** — replace (reversible) and redact
- **De-anonymization** — reverse replacements with key

## Install

```bash
npm install @stll/anonymize
# Optional: install data package for deny lists
npm install @stll/anonymize-data
```

## Quick Start

```typescript
import { runPipeline } from '@stll/anonymize'

const entities = await runPipeline({
  fullText: text,
  config: {
    labels: ['person', 'organization', 'address',
             'date', 'iban', 'phone number'],
    threshold: 0.5,
    enableRegex: true,
    enableTriggerPhrases: true,
    enableLegalForms: true,
    enableNameCorpus: true,
    enableDenyList: false,
    enableGazetteer: false,
    enableNer: false,
    enableConfidenceBoost: true,
    enableCoreference: true,
    workspaceId: 'default',
  },
  gazetteerEntries: [],
})
```

## Architecture

```
text → [regex]       → entities₁ ─┐
text → [triggers]    → entities₂ ─┤
text → [legal forms] → entities₃ ─┤
text → [name corpus] → entities₄ ─┼→ merge → coref → boost → filter → result
text → [gazetteer]   → entities₅ ─┤
text → [GLiNER NER]  → entities₆ ─┘
```

## Built on

- [@stll/text-search](https://github.com/stella/text-search) — multi-engine search orchestrator
- [@stll/stdnum](https://github.com/stella/stdnum) — identifier validation (IBAN, IČO, RČ)
- [@stll/anonymize-data](https://github.com/stella/anonymize) — deny-list dictionaries

## License

MIT
