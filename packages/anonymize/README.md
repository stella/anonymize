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

## Built on

- `@stll/text-search`
- `@stll/stdnum`
- `@stll/anonymize-data`
