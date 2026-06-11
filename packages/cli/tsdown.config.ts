import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  hash: false,
});
