---
"@stll/anonymize": patch
---

Improve gazetteer name matching.

- Match entries as whole words, folded for letter case and diacritics in both
  directions, and surname-first person names (`Dvořáková, Marie`). When Czech
  or Slovak is in the content-language scope (or no scope is set), Czech and
  Slovak case forms and feminine and possessive surname forms match too.
- Keep leading and trailing punctuation of an entry (`C++`, `@alice`) part of
  its match.
- Match a company entry with or without its legal form, in any spacing or
  comma variant (`s.r.o.`, `s. r. o.`, `spol. s r.o.`, `a. s.`).
- Accept fuzzy matches only on token boundaries, with an edit distance scaled
  to the entry's length; entries shorter than six letters and entries with
  digits match only exactly.
- Never match inside identifier-shaped tokens such as hashes, UUID parts,
  base64 runs, or markers, while names next to numbers, years, or words
  (`Acme/2024`, `novak2@acme.cz`, `Novak_smlouva_2024.pdf`) still match.
- Extend a match only over a following legal form.

Prepared packages carry a new gazetteer field; rebuild persisted packages.
