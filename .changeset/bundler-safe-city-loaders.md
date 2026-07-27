---
"@stll/anonymize-data": patch
---

Load city dictionaries through literal `import()` specifiers so bundled
consumers get real city data. The previous computed specifier could not be
rewritten by any bundler, so every city dictionary resolved to nothing in a
bundled build and was swallowed into an empty list, silently under-redacting
addresses. A country with a bundled dictionary now throws when its dictionary
fails to load; an uncovered country still returns an empty list, and
`hasCityDictionary` plus `CITY_DICTIONARY_COUNTRIES` expose the difference.
