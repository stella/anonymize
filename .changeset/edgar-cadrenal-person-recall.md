---
"@stll/anonymize": patch
---

Improve EDGAR contract person recall and precision: reject person-name fragments inside hyphen compounds such as the "Frank" in "Dodd-Frank" (while keeping hyphenated place names), stop attaching generational Roman numerals as city districts after a personal-name prefix, reject street-containing statute titles as addresses, and add English name-corpus entries for common notice-block contacts.
