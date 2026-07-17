---
"@stll/anonymize": patch
---

Fix PII false-negative regressions and hardening in the Rust detection core.
Overlap resolution is now width-aware so caller-supplied and custom detections
are not silently overridden by smaller built-in spans (and a narrow custom span
no longer evicts the wider built-in it sits inside), with a symmetric guard that
keeps a country nested in an address from clobbering the address. Legal-form
detection recovers organizations after dotted abbreviations and across
connectors and keeps digit-led names. Trigger detection adds missing name
particles, stops mis-capping line-delimited and long comma-terminated values,
accepts dot-space phone separators, and treats slash dates as non-phone padding.
Name and deny-list handling stops discarding global-corpus names, allow-listed
single-word organization aliases, and lowercase street addresses, and stops a
cross-language stopword collision from suppressing a real single-token name.
Raw native package payloads are size-checked before digest verification and
decoding.
