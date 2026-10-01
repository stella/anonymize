---
"@stll/anonymize": patch
---

Improve gazetteer name matching for short names and template placeholders.

- A five-letter entry spelled as a proper noun (`Orbis`, `ORBIS`) now also
  matches a one-letter substitution typo (`Orbys`) on a whole token in the
  same case that does not open a sentence. Lowercase words (`orbit`) and
  shorter entries still match only exactly.
- Inside template placeholders `<<…>>`, `{{…}}` and `[[…]]`, a name glued
  to digits or joined to a numbered field (`<<token:zeta9>>`) is not
  matched; a plain name inside them (`[[Jan Novák]]`) still is.
- A gazetteer entry that is also a common word (`Mark`, `Will`, `Grant`) is
  always redacted where it stands as its own token, for every label.
