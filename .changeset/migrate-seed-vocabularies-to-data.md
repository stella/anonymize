---
"@stll/anonymize": patch
---

Remove redundant hardcoded sentence-verb and address-stop seeds. First-name stopword exclusions now come only from the effective language-scoped name corpus, preventing one language's names from changing another language's deny-list behavior.
