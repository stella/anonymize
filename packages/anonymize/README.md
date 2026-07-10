<p align="center">
  <img src="../../.github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

# @stll/anonymize

Runtime package for multi-layer PII detection and anonymization.

It combines regex detectors, trigger phrases, deny-list matching, and coreference handling in a single deterministic pipeline that works in native Node.js and in browser builds through the WASM entrypoint.

## Install

```bash
bun add @stll/anonymize
# Optional data bundle for deny lists and dictionaries
bun add @stll/anonymize-data
```

The Node.js package is Rust-native. Browser/WASM support is maintained through
`@stll/anonymize-wasm`, which wraps the same native core.

## Usage: Node.js native SDK

```ts
import {
  availableDefaultNativePipelineLanguages,
  getDefaultNativePipeline,
} from "@stll/anonymize/native-node";

const languages = availableDefaultNativePipelineLanguages();
const anonymizer = getDefaultNativePipeline(
  languages.includes("en") ? { language: "en" } : {},
);
const result = anonymizer.redact_text(text);

console.log(result.redaction.redactedText);
```

Call `getDefaultNativePipeline()` once during service startup and reuse the returned anonymizer. The package ships with a prepared native package, so the normal request path avoids rebuilding search automata. Use `preloadDefaultNativePipeline()` or `preloadDefaultNativePipelineAsync()` when the first document should not pay lazy regex warm-up.

If your deployment knows the document language up front, select a scoped package at startup. The build emits `en`, `cs`, and `de` scoped packages by default, and `STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES` can replace that list or be set to an empty value to build only the all-language package:

```bash
STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES=en,cs,fr bun run build
```

```ts
const anonymizer = getDefaultNativePipeline({ language: "en" });
```

Regional codes use the exact package when present and otherwise fall back to
the base language package, so `en-US` can use the shipped `en` artifact.

For build-time generated packages or caller-owned data, prepare the package before runtime and load the bytes in the process that handles documents.

```bash
bunx stella-anonymize-build-native-package \
  --config ./anonymize-native-config.mjs \
  --out ./dist/anonymize.stlanonpkg
```

```ts
import { load_prepared_package_file } from "@stll/anonymize/native-node";

const anonymizer = load_prepared_package_file("./dist/anonymize.stlanonpkg");
anonymizer.warmLazyRegex();
const warmDiagnosticsJson = anonymizer.warmLazyRegexDiagnosticsJson();
const result = anonymizer.redact_text(text, { redactString: "***" });
```

Per-label operators support `replace`, `redact`, and `keep`. `keep` records
that an entity was processed while leaving its source text unchanged; it
creates no reversible redaction-key entry:

```ts
const result = anonymizer.redactText(text, {
  operators: { organization: "keep" },
});
```

Caller-produced spans enter the same resolution and redaction pipeline. Node
and browser offsets use JavaScript UTF-16 string indexes; matched text is
derived from the input:

```ts
const result = anonymizer.redactTextWithCallerDetections("😀Alice signed.", {
  detections: [
    {
      start: 2,
      end: 7,
      label: "person",
      score: 0.95,
      providerId: "example-ner",
      detectionId: "person-1",
    },
  ],
});
```

`providerId` and `detectionId` are required provenance identifiers. They must
be 1–128 ASCII characters, start with an alphanumeric character, and otherwise
contain only alphanumerics, `.`, `_`, `:`, or `-`; do not encode personal data
in them. Retained result entities preserve both IDs. Use
`redactTextWithCallerDetectionsDiagnosticsJson()` for audit-safe input and
retained counts. Diagnostic events include provenance, labels, offsets, and
scores, but never matched text.

The config module may export a `PipelineConfig` directly or `{ config, gazetteerEntries }`. Include `@stll/anonymize-data` dictionaries there if your runtime config uses the deny-list or name-corpus layers; keep the corresponding layers enabled for caller-owned `customDenyList`, `customRegexes`, and gazetteers. Those inputs are part of the prepared package and should be regenerated when they change.

## Python SDK

```py
import stella_anonymize as anonymize

languages = anonymize.available_default_native_pipeline_languages()
prepared = anonymize.preload_default_native_pipeline(
    language="en" if "en" in languages else None
)
result = prepared.redact_text(text, redact_string="***")

print(result.redaction.redacted_text)
```

Python caller detections use Python character indexes:

```py
result = prepared.redact_text_with_caller_detections(
    "😀Alice signed.",
    [{"start": 1, "end": 6, "label": "person", "score": 0.95,
      "provider_id": "example-ner", "detection_id": "person-1"}],
)
```

Python preserves `provider_id` and `detection_id` on retained entities. Use
`redact_text_with_caller_detections_diagnostics_json()` for the same audit-safe
diagnostics contract.

The Python SDK uses the same Rust core and prepared-package contract as the Node SDK. Prefer `get_default_native_pipeline()`, `preload_default_native_pipeline()`, `load_prepared_package()`, or `load_prepared_package_file()` for repeated calls; top-level `redact_text()` and `redact_text_json()` prepare from config on each call.

## Caller-Owned Deny Lists and Regexes

Use `customDenyList` for exact terms and variants that you control. Use
`customRegexes` for deterministic patterns that are not built into the package.
Caller-owned data is part of the prepared package, so build or load a package
from that config before serving documents.

```ts
import {
  createNativePipelineFromConfig,
  loadNativeAnonymizeBinding,
} from "@stll/anonymize/native-node";

const binding = loadNativeAnonymizeBinding();
const pipeline = await createNativePipelineFromConfig({
  binding,
  config: {
    ...baseConfig,
    enableDenyList: true,
    enableRegex: true,
    customDenyList: [
      {
        value: "Project Nebula",
        variants: ["Nebula Programme"],
        label: "organization",
      },
    ],
    customRegexes: [
      {
        pattern: "\\bSTLL-[0-9]{4}\\b",
        label: "matter reference",
        score: 1,
      },
    ],
  },
  gazetteerEntries: [],
});

const result = pipeline.redactText(text);
```

## Browser setup

If you use Vite with the WASM build, exclude the bundle from dependency pre-bundling:

```ts
import stllWasm from "@stll/anonymize-wasm/vite";

export default {
  plugins: [stllWasm()],
};
```

## Notes

- Native architecture and extension guidance:
  [`ARCHITECTURE.md`](ARCHITECTURE.md).
- `labels: []` disables deterministic label filtering.
- `enableNer` is a compatibility field for the removed TypeScript pipeline. The
  native pipeline rejects `true`; model-produced spans will use a separate
  caller-detection API.
- `enableNameCorpus` also controls whether first names, surnames, and titles are injected into deny-list matching when `enableDenyList` is enabled.
- The optional `@stll/anonymize-data` package carries the published dictionary and trigger data used when building prepared packages.
- `customDenyList` and `customRegexes` are part of the prepared package input and should be regenerated when they change.
- The old TypeScript pipeline is kept only as temporary internal migration/test scaffolding under `src/legacy.ts`; it is not the product runtime.

## Built on

- `@stll/text-search`
- `@stll/stdnum`
- `@stll/anonymize-data`
