---
"@stll/anonymize": patch
---

Bound the previously unbounded default-pipeline and shared prepared-package
caches with LRU eviction, and normalize the default-pipeline cache key so
locale aliases that resolve to the same bundled package no longer each retain a
distinct entry. Prevents attacker/user-varyable language tags, custom deny
lists, regexes, or gazetteer data from growing process memory without limit.
