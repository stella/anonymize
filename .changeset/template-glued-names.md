---
"@stll/anonymize": patch
---

Inside template placeholders `<<…>>`, `{{…}}` and `[[…]]`, a name glued to
digits (`[[Zeta2024]]`, `{{Acme2024}}`) is now matched when it is spelled in
its gazetteer entry's case. A field spelled otherwise (`<<token:zeta9>>`,
`{{acme_01}}`) is still not matched.
