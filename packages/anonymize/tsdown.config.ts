import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/constants.ts"],
    outDir: "dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
  },
  {
    entry: ["src/wasm.ts", "src/constants.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
    deps: {
      neverBundle: [
        /^@stll\/text-search-wasm$/,
        /^@stll\/aho-corasick-wasm$/,
        /^@stll\/fuzzy-search-wasm$/,
        /^@stll\/regex-set-wasm$/,
      ],
    },
  },
  {
    entry: ["src/vite.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    hash: false,
    deps: { neverBundle: [/^vite$/] },
  },
]);
