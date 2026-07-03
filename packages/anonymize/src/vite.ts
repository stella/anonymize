/* Vite plugin that wires up @stll/anonymize-wasm so its wasm binding and
 * prepared-package assets survive Vite's dep pre-bundler.
 *
 * The package loads its napi-rs binding at runtime from its own `native/`
 * asset directory via `new URL("./native/…", import.meta.url)` (the wasm
 * module, the WASI worker, and the bundled `.stlanonpkg` packages). Vite's
 * optimizer would rewrite those module paths and break the relative URL
 * resolution, so the package plus the `@napi-rs/wasm-runtime` loader it depends
 * on are added to `optimizeDeps.exclude`, keeping their original paths. */
import type { Plugin } from "vite";

const PACKAGES = ["@stll/anonymize-wasm", "@napi-rs/wasm-runtime"];

export default function stllAnonymizeWasmVite(): Plugin {
  return {
    name: "stll-anonymize-wasm",
    apply: "serve",
    config() {
      return {
        optimizeDeps: { exclude: PACKAGES },
      };
    },
  };
}
