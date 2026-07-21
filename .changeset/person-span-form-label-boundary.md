---
"@stll/anonymize": patch
---

Stop person spans at signature-stamp phrases and colon-tied form-field labels. The vocabulary is language-keyed data in `signature-detection.json` and is applied once, in the resolution boundary pass, instead of per detector.
