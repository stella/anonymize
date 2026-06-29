<p align="center">
  <img src="../../.github/assets/banner.png" alt="stella anonymize" width="100%" />
</p>

# @stll/anonymize

Runtime package for multi-layer PII detection and anonymization.

It combines regex detectors, trigger phrases, deny-list matching, coreference handling, and NER into a single pipeline that works in native Node.js and in browser builds through the WASM entrypoint.

## Install

```bash
bun add @stll/anonymize
# Optional data bundle for deny lists and dictionaries
bun add @stll/anonymize-data
```

For browser targets, install `@stll/anonymize-wasm` instead. It exposes the same runtime API through WebAssembly and is the supported entrypoint for Vite-based bundles.

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

The Python SDK uses the same Rust core and prepared-package contract as the Node SDK. Prefer `get_default_native_pipeline()`, `preload_default_native_pipeline()`, `load_prepared_package()`, or `load_prepared_package_file()` for repeated calls; top-level `redact_text()` and `redact_text_json()` prepare from config on each call.

## Caller-Owned Deny Lists and Regexes

Use `customDenyList` for exact terms and variants that you control. These are matched by the deny-list layer, so keep `enableDenyList: true`.

```ts
const entities = await runPipeline({
  fullText: text,
  config: {
    ...baseConfig,
    enableDenyList: true,
    customDenyList: [
      {
        value: "Project Nebula",
        variants: ["Nebula Programme"],
        label: "organization",
      },
    ],
  },
  gazetteerEntries: [],
});
```

Use `customRegexes` for deterministic patterns that are not built into the package. These are matched by the regex layer, so keep `enableRegex: true`.

```ts
const entities = await runPipeline({
  fullText: text,
  config: {
    ...baseConfig,
    enableRegex: true,
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
```

## TypeScript Pipeline Compatibility

The async TypeScript pipeline remains available for compatibility and for browser/WASM builds.

```ts
import { runPipeline } from "@stll/anonymize";

const entities = await runPipeline({
  fullText: text,
  config,
  gazetteerEntries: [],
});
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

- `labels: []` disables deterministic label filtering; when NER is enabled it falls back to the default label set.
- `enableNameCorpus` also controls whether first names, surnames, and titles are injected into deny-list matching when `enableDenyList` is enabled.
- The optional `@stll/anonymize-data` package carries the published dictionary and trigger data used by the deny-list layer.
- `customDenyList` and `customRegexes` are part of the pipeline config and are included in the internal search cache key.

## Built on

- `@stll/text-search`
- `@stll/stdnum`
- `@stll/anonymize-data`
