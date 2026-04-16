# @stll/anonymize-wasm

Browser-friendly build of `@stll/anonymize`.

Use this package when you need the runtime API in a browser or bundler environment. It ships the WebAssembly build and the Vite helper that keeps the wasm assets out of dependency pre-bundling.

## Install

```bash
bun add @stll/anonymize-wasm
```

## Usage

```ts
import { runPipeline } from "@stll/anonymize-wasm";
import stllWasm from "@stll/anonymize-wasm/vite";
```

## Notes

- This package depends on the same core runtime behavior as `@stll/anonymize`.
- If you use Vite, include the helper plugin so wasm asset resolution stays intact.
