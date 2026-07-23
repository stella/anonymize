---
"@stll/anonymize": patch
---

Move the last two hardcoded false-positive vocabularies into per-language data: building unit designators (`unit-designators.json`) and in-name connective words (`in-name-connectors.json`). Both are now threaded through the prepared config's false-positive filters instead of inline Rust consts. Behavior-neutral (same word sets). The `check:vocab` gate now also skips Rust `#[cfg(test)]` modules so test fixtures do not trip it, and its allowlist no longer carries any migration debt.
