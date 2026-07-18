---
"@stll/anonymize": patch
---

Remove unused runtime dependencies (`@huggingface/tokenizers`, `@stll/stdnum`, `@stll/text-search`) left over from the removed TypeScript detection pipeline. ID validation, search, and tokenization live in the Rust core; these packages were no longer imported anywhere but still installed for every consumer.
