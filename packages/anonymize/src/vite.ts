/* Vite plugin that wires up @stll/anonymize-wasm so its transitive
 * napi-rs-generated wasm loaders survive Vite's dep pre-bundler. Adds
 * this package plus its @stll/*-wasm dependencies to optimizeDeps.exclude
 * so the loader modules are served with their original paths, keeping
 * `new URL("./foo.wasm", import.meta.url)` correct. */
import type { Plugin } from "vite";

// Only the napi-rs WASM packages need excluding — they use
// `new URL("./foo.wasm", import.meta.url)` which Vite's optimizer
// would rewrite. @stll/anonymize-wasm itself is pure JS and should
// NOT be excluded.
const PACKAGES = [
  "@stll/text-search-wasm",
  "@stll/aho-corasick-wasm",
  "@stll/aho-corasick-wasm32-wasi",
  "@stll/fuzzy-search-wasm",
  "@stll/fuzzy-search-wasm32-wasi",
  "@stll/regex-set-wasm",
  "@stll/regex-set-wasm32-wasi",
];

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
