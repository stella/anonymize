import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: { generator: "oxc" },
  entry: ["src/index.ts", "src/server-entry.ts", "src/server.ts"],
  fixedExtension: true,
  format: ["esm"],
  hash: false,
  platform: "node",
  sourcemap: true,
});
