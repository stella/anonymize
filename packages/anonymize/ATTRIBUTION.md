# Attribution

This library builds on ideas and patterns from several open-source
projects and academic research. No code was copied; all
implementations are original.

## Prior Art

### Microsoft Presidio (Apache 2.0)

- Context-word boosting architecture
- Structured PII pattern design (IBAN, phone, email)
- Operator concept (replace vs redact)
- https://github.com/microsoft/presidio

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
