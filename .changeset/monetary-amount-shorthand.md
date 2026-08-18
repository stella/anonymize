---
"@stll/anonymize": patch
---

Detect attached lowercase magnitude shorthand (`$25m`, `£500k`), the English `B` billion abbreviation (`$1.5B`), and abbreviated magnitudes followed by a period before the currency (`12,5 Mio. Euro`). Amount-prefix triggers such as `in the amount of`, `ve výši`, and `in Höhe von` now stop after the amount instead of extending to the next comma or sentence end.
