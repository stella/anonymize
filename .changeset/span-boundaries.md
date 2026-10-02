---
"@stll/anonymize": patch
---

Redaction spans keep to their entity. In scripts written without spaces
(Japanese, Chinese, Korean, Thai, Lao, Khmer, Myanmar) a span stays on the
matched characters instead of growing over the surrounding run, and every
span starts and ends on a grapheme cluster boundary, so no combining mark is
split off. A name or legal-form organization inside delimiters (`<<…>>`,
`«…»`, `„…“`, `「…」`, `（…）`, quotes) leaves the closing delimiter in place,
and person and legal-form name scans stop where Latin-script text meets an
unspaced script.
