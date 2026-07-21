# Attribution

This library builds on ideas and patterns from several open-source
projects and academic research. No code was copied; all
implementations are original.

## Prior Art

### Microsoft Presidio (MIT)

- Context-word boosting architecture
- Structured PII pattern design (IBAN, phone, email)
- Unicode/IDN domain-label handling and validation-first phone matching,
  adapted from pinned commit `efc775903f55c3e50e12b5902ec2699c2e52fdf7`
- Internationalized domains use bounded RFC-like label shapes and accept
  decomposed Unicode combining marks. Punycode receives shape validation only,
  not complete IDNA validation.
- Operator concept (replace vs redact)
- https://github.com/microsoft/presidio/tree/efc775903f55c3e50e12b5902ec2699c2e52fdf7

### Scrubadub (Apache 2.0)

- RFC-style email local-part symbol coverage and conservative written
  `at`/`dot` email grammar
- Validation-first phone matching principles
- Adapted from pinned commit `53772cbef417da290d25c95373031f786ab3b5c6`
- https://github.com/LeapBeyond/scrubadub/tree/53772cbef417da290d25c95373031f786ab3b5c6

### GLiNER / GLiNER.js (MIT)

- Span-level and token-level NER via ONNX
- The `gliner/` module is an original implementation informed
  by the GLiNER architecture (arXiv:2311.08526)
- Processor and decoder logic reimplemented from scratch
- https://github.com/urchade/GLiNER

### NameTag / MorphoDiTa (ÚFAL, Charles University)

- Czech NER and morphological analysis research
- Czech name declension suffix patterns
- https://ufal.mff.cuni.cz/nametag
- https://ufal.mff.cuni.cz/morphodita

### Text Anonymization Benchmark (NorskRegnesentral, MIT)

- ECHR court case evaluation methodology
- Entity type taxonomy for legal documents
- https://github.com/NorskRegnesentral/text-anonymization-benchmark

### Unicode CLDR

- Multilingual month name data
- https://cldr.unicode.org (Unicode License)

## Deny List Data Sources

### FinNLP/humannames (MIT)

- ~195,000 person names (global, multilingual)
- Used in: `dictionaries/names/global.json`
- https://github.com/FinNLP/humannames
- License: MIT

### Wikidata — Given Names and Family Names (CC0 1.0)

- Per-language given names and family names for 11
  European languages (cs, sk, de, pl, hu, ro, fr,
  es, it, en, sv)
- Queried via Wikidata SPARQL (P31: Q202444 given
  name, Q101352 family name)
- Used in: `dictionaries/names/first/*.json`,
  `dictionaries/names/surnames/*.json`
- Czech/Slovak feminine surname forms (-ová, -á)
  generated algorithmically from masculine forms
- https://www.wikidata.org
- License: Creative Commons CC0 1.0 Universal
  Public Domain Dedication

### GeoNames (CC BY 4.0)

- City and place names from the GeoNames gazetteer
- Population threshold: ≥1,000 inhabitants
- Includes native names, ASCII transliterations, and
  alternate names across languages
- Used in: `dictionaries/cities/*.json`
- https://www.geonames.org
- License: Creative Commons Attribution 4.0 International

### Wikidata (CC0 1.0)

- Courts, banks, insurance companies, government ministries,
  universities, hospitals, and EU institutions
- Labels and alternate labels in cs, sk, de, en
- Used in: `dictionaries/courts/`, `dictionaries/banks/`,
  `dictionaries/insurance/`, `dictionaries/government/`,
  `dictionaries/education/`, `dictionaries/healthcare/`,
  `dictionaries/international/`
- https://www.wikidata.org
- License: Creative Commons CC0 1.0 Universal
