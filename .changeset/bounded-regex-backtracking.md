---
"@stll/anonymize": patch
---

Bound regex backtracking in trigger matching. Configuration-supplied
`match-pattern` trigger patterns are now built through a single wrapper that
prefers the linear-time `regex` engine and only falls back to `fancy_regex`
(with an explicit backtrack limit) for patterns that genuinely need lookaround
or backreferences. A pathological pattern/input pair now fails with a typed
error instead of consuming unbounded CPU, closing a ReDoS vector; ordinary
patterns match identically.
