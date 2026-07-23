---
"@stll/anonymize-wasm": patch
---

Load the wasm binding under Bun as well as Node. The napi-rs-generated WASI glue built its WASI from `node:wasi`, whose `WASI` lacks `.initialize()` under Bun (the wasm binding is a reactor module, so emnapi calls `wasi.initialize`), causing `wasi.initialize is not a function`. The Node and threads-worker loaders now use the portable `@napi-rs/wasm-runtime` WASI (already used by the browser loader), so the binding loads and runs identically on both runtimes. A CI runtime matrix runs the wasm smokes under Node and Bun to keep this from regressing.
