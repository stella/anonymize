import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["dictionaries/index.ts"],
  format: ["esm"],
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  hash: false,
  unbundle: true,
});
