import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
  },
  {
    entry: ["src/wasm.ts"],
    outDir: "wasm/dist",
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
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
