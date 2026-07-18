---
"@stll/anonymize": minor
---

Migrate the prepared-package payload codec from the unmaintained `bincode` (RUSTSEC-2025-0141) to `postcard`, and bump every `.stlanonpkg` format version. Packages built by earlier releases are rejected with the typed "unsupported version" error; rebuild persisted packages with `stella-anonymize-build-native-package` or `prepareNativePipelinePackage` after upgrading. The bundled default packages are rebuilt automatically at release time, so callers using `getDefaultNativePipeline` are unaffected.
