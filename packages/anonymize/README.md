<p align="center">
  <img src="../../.github/assets/banner.png" alt="Stella anonymize" width="100%" />
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

## Usage

```ts
import { runPipeline } from "@stll/anonymize";

const entities = await runPipeline({
  fullText: text,
  config: {
    labels: [
      "person",
      "organization",
      "address",
      "date",
      "iban",
      "phone number",
    ],
    threshold: 0.5,
    enableRegex: true,
    enableTriggerPhrases: true,
    enableLegalForms: true,
    enableNameCorpus: true,
    enableDenyList: false,
    enableGazetteer: false,
    enableNer: false,
    enableConfidenceBoost: true,
    enableCoreference: true,
    workspaceId: "default",
  },
  gazetteerEntries: [],
});
```

## Caller-owned deny lists and regexes

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
