---
"@stll/anonymize": patch
---

Improve gazetteer name matching for short names and template placeholders.

- A five-letter entry spelled as a proper noun (`Orbis`, `ORBIS`) now also
  matches a one-letter substitution typo (`Orbys`) on a whole token in the
  same case that does not open a sentence. Lowercase words (`orbit`) and
  shorter entries still match only exactly.
- Template placeholders `<<…>>`, `{{…}}` and `[[…]]` are treated like `⟦…⟧`
  markers, so a configured name inside them is not matched.
