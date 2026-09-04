---
"@stll/anonymize-pdf": major
---

Add digest-bound manual PDF redaction regions to the verified destructive raster rewrite. Certificates report manual and detector-selected regions separately.

Raster certificates now use contract version 2 because `manualRegionCount` is required. Consumers must handle the new certificate shape explicitly; version 1 certificates are not decoded as version 2. Raster requests and PDF inspections remain at contract version 1.
