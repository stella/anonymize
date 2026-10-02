---
"@stll/anonymize": patch
---

Inside template placeholders `<<…>>`, `{{…}}` and `[[…]]`, a name glued to
digits (`[[Zeta2024]]`, `[[McDonald2024]]`, `[[Jan van Dijk2024]]`) is now
matched when it is spelled as its gazetteer entry spells it, or in the same
capitalization. A field spelled otherwise (`<<token:zeta9>>`, `{{acme_01}}`)
is still not matched.
