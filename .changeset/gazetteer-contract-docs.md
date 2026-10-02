---
"@stll/anonymize": patch
---

A gazetteer spelling given under several labels now takes the first of them in
the pipeline's `labels` order (the alphabetically first without a label
filter), so the label no longer depends on entry order and a kept label always
wins.
