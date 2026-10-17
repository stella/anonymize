import { expect, test } from "bun:test";

import { assertPackedRuntimeImports } from "../../../../.github/tools/packed-runtime-imports";

const fixture = () =>
  new Map([
    ["scripts/cli.mjs", 'import "./helper.mjs";'],
    [
      "scripts/helper.mjs",
      'export { value } from "../dist/value.mjs"; void import("./dynamic.mjs");',
    ],
    ["scripts/dynamic.mjs", "export const value = 1;"],
    [
      "dist/value.mjs",
      'import "../scripts/helper.mjs"; export const value = 1;',
    ],
    [
      "other.cjs",
      'module.exports = require("./nested"); require.resolve("./resolved");',
    ],
    ["resolved.js", "module.exports = 1;"],
    ["nested/index.js", 'require("node:fs"); require("external-package");'],
  ]);
const manifest = {
  main: "./other.cjs",
  bin: { command: "./scripts/cli.mjs" },
  exports: { ".": { types: "./missing.d.ts", import: "./dist/value.mjs" } },
};

test("every shipped script and transitive static import must be packed", () => {
  const files = fixture();
  expect(
    assertPackedRuntimeImports({
      manifest,
      packedFiles: new Set(files.keys()),
      readSource: (path) => files.get(path),
    }),
  ).toEqual(new Set(files.keys()));
  for (const omitted of files.keys()) {
    const packedFiles = new Set(files.keys());
    packedFiles.delete(omitted);
    expect(() =>
      assertPackedRuntimeImports({
        manifest,
        packedFiles,
        readSource: (path) => files.get(path),
      }),
    ).toThrow("not packed");
  }
});

test("packed scripts outside bin and exports are closure roots too", () => {
  const files = fixture();
  files.set("extra.mjs", 'import "./unpacked.mjs";');
  expect(() =>
    assertPackedRuntimeImports({
      manifest,
      packedFiles: new Set(files.keys()),
      readSource: (path) => files.get(path),
    }),
  ).toThrow("extra.mjs -> ./unpacked.mjs");
});

test("runtime closure excludes type-only and computed dynamic imports", () => {
  const source =
    'import type { Missing } from "./type-only"; const target = "./dynamic.mjs"; void import(target); export const value = 1;';
  expect(
    assertPackedRuntimeImports({
      manifest: { bin: "./cli.ts" },
      packedFiles: new Set(["cli.ts"]),
      readSource: () => source,
    }),
  ).toEqual(new Set(["cli.ts"]));
});

test("missing declared entry artifacts and missing source cannot pass", () => {
  expect(() =>
    assertPackedRuntimeImports({
      manifest: { exports: "./dist/absent.mjs" },
      packedFiles: new Set(),
      readSource: () => undefined,
    }),
  ).toThrow("not packed");
  expect(() =>
    assertPackedRuntimeImports({
      manifest: {},
      packedFiles: new Set(["cli.mjs"]),
      readSource: () => undefined,
    }),
  ).toThrow("source is missing");
});

test("escaping paths and unresolved package-local mappings fail closed", () => {
  for (const specifier of [
    "../outside.mjs",
    "#private",
    "/absolute.mjs",
    "file:///outside.mjs",
  ]) {
    expect(() =>
      assertPackedRuntimeImports({
        manifest: {},
        packedFiles: new Set(["cli.mjs"]),
        readSource: () => `import "${specifier}";`,
      }),
    ).toThrow();
  }
});

test("declared extensionless bins traverse their static runtime imports", () => {
  const files = new Map([
    ["bin/cli", '#!/usr/bin/env node\nimport "./helper.mjs";'],
    ["bin/helper.mjs", "export const value = 1;"],
  ]);
  const options = {
    manifest: { bin: { cli: "bin/cli" } },
    packedFiles: new Set(files.keys()),
    readSource: (path: string) => files.get(path),
  };
  expect(assertPackedRuntimeImports(options)).toEqual(new Set(files.keys()));
  options.packedFiles.delete("bin/helper.mjs");
  expect(() => assertPackedRuntimeImports(options)).toThrow(
    "bin/cli -> ./helper.mjs",
  );
});
