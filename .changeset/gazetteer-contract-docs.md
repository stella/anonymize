---
"@stll/anonymize": patch
---

A gazetteer spelling given under several labels now takes the first of them
that the pipeline searches for (its `labels`, then the labels hotword rules
reclassify into them; the alphabetically first without a label filter), so the
label no longer depends on entry order and a kept label always wins.
Spellings that differ only in case or diacritics count as one for this.

Exact gazetteer hits and custom deny-list hits are now redacted whatever the
pipeline's `threshold`; typo hits keep it. Names glued to Hangul Jamo,
halfwidth Katakana, and the other blocks of scripts written without spaces now
match like names glued to CJK ideographs.
