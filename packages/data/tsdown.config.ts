import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["dictionaries/index.ts", "dictionaries/cities.ts"],
  format: ["esm"],
  dts: { generator: "oxc" },
  clean: true,
  sourcemap: true,
  hash: false,
  unbundle: true,
});
