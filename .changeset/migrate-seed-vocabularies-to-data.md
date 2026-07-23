---
"@stll/anonymize": patch
---

Move three hardcoded assembler vocabularies into per-language data: the sentence-verb and address-stop seeds were redundant duplicates of their data files and are now dropped, and the supplementary first-name exclusions move to `supplementary-name-exclusions.json`. The assembled entity sets are unchanged (behavior-neutral); only the internal ordering of the sentence-verb set differs.
