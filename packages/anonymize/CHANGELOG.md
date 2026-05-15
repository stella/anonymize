# Changelog

## Unreleased

## 1.4.1 (2026-05-15)

### Fixes

- Capture legal-form organization names with internal commas, single-letter party names, dotted firm initials, ampersands, and comma-separated suffixes.
- Keep structural schedule/article/exhibit labels and ordinary sentence-final words out of legal-form organization matches.
- Move financial magnitude and share-quantity lexicons into language data while avoiding ambiguous global suffix false positives.
- Document the runtime package more clearly for install and browser usage.
- Keep the data package peer dependency aligned with the published data surface.

## 0.0.1 (2026-03-22)

### Features

- Multi-layer PII detection pipeline
- Regex detector (IBAN, email, phone, dates, IDs)
- Trigger phrase detector (10 languages)
- Legal form detector (20+ countries)
- Name corpus with Czech/Slovak declension
- GLiNER zero-shot NER integration
- Aho-Corasick + fuzzy deny-list gazetteer
- Coreference resolution (defined-term tracking)
- Confidence boosting and false positive filtering
- Replace and redact operators
- De-anonymization support
