---
"@stll/anonymize": patch
---

Stop address detection expanding past a trailing coordinating conjunction. A per-language coordinating-conjunction grammar list (`conjunctions.json`) is composed into address-seed boundaries, so a return address no longer absorbs the notice prose that follows it ("7812 Palm Parkway, Orlando, Florida 32836, or emailed to ..." now ends at the ZIP).
