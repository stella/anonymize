#!/usr/bin/env node
/**
 * Assemble the browser assets for @stll/anonymize-wasm into `wasm/dist/native/`.
 *
 * Prerequisites (run in order):
 *   1. `bun run build:native-wasm`  -> produces `native-wasm-dist/` (the napi-rs
 *      wasm32-wasip1-threads binding + WASI/browser glue). Needs the Rust
 *      toolchain with the `wasm32-wasip1-threads` target (pinned in
 *      `rust-toolchain.toml`, so `rustup` installs it automatically).
 *   2. `bun run build`              -> runs tsdown (produces `wasm/dist/`) and
 *      the native node binding used to build the prepared packages below.
 *
 * This script then:
 *   - copies the wasm binary and the Node WASI glue + worker into
 *     `wasm/dist/native/`, next to the bundled `wasm.mjs` entry so its
 *     `new URL("./native/…", import.meta.url)` lookups resolve;
 *   - bundles the browser WASI glue + worker into the same directory with
 *     `bun build`, inlining `@napi-rs/wasm-runtime` so the shipped browser glue
 *     is self-contained (a consumer's bundler emits it as a raw asset and never
 *     rewrites its specifiers);
 *   - builds the LZ4-compressed default prepared package (and per-language
 *     variants) into the same directory for `loadDefaultPipeline()`.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.STELLA_ANONYMIZE_SKIP_WASM_BUILD === "1") {
  console.log(
    "build-native-wasm-assets: skipped (STELLA_ANONYMIZE_SKIP_WASM_BUILD=1)",
  );
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmDistDir = join(packageRoot, "native-wasm-dist");
const distNativeDir = join(packageRoot, "wasm", "dist", "native");
const DEFAULT_SCOPED_PACKAGE_LANGUAGES = ["cs", "de", "en"];
const scopedLanguages = languageListFromEnv(
  process.env.STELLA_ANONYMIZE_WASM_PACKAGE_LANGUAGES,
  DEFAULT_SCOPED_PACKAGE_LANGUAGES,
);

// The wasm binary and Node glue are copied verbatim. Node resolves the bare
// `require("@napi-rs/wasm-runtime")` from the package's own node_modules at
// runtime (the loader climbs up from wasm/dist/native/), so the Node glue does
// not need bundling.
const COPY_FILES = [
  "index.wasm32-wasi.wasm",
  "index.wasi.cjs",
  "wasi-worker.mjs",
];
// Browser glue is bundled (not copied): the napi-rs-generated files import
// `@napi-rs/wasm-runtime` by bare specifier, and consumer bundlers (Vite/Rollup)
// emit them as raw assets without rewriting specifiers, so a production browser
// build would fail to instantiate the binding. Bundling with `bun build` inlines
// `@napi-rs/wasm-runtime` (and its deps) so the shipped glue is self-contained.
// The `.wasm` binary and the worker stay referenced by relative
// `new URL(..., import.meta.url)`; bun leaves those runtime URLs intact so they
// still resolve to the sibling files in `native/`.
const BROWSER_GLUE_ENTRIES = [
  "index.wasi-browser.js",
  "wasi-worker-browser.mjs",
];

if (!existsSync(wasmDistDir)) {
  throw new Error(
    `Missing ${wasmDistDir}. Run "bun run build:native-wasm" first.`,
  );
}
if (!existsSync(join(packageRoot, "wasm", "dist", "wasm.mjs"))) {
  throw new Error(
    `Missing wasm/dist/wasm.mjs. Run "bun run build" (tsdown) first.`,
  );
}

mkdirSync(distNativeDir, { recursive: true });
const glue = [];
for (const fileName of COPY_FILES) {
  const source = requireArtifact(fileName);
  const destination = join(distNativeDir, fileName);
  copyFileSync(source, destination);
  glue.push({
    file: fileName,
    mode: "copy",
    bytes: statSync(destination).size,
  });
}
for (const fileName of BROWSER_GLUE_ENTRIES) {
  const source = requireArtifact(fileName);
  const destination = join(distNativeDir, fileName);
  bundleBrowserGlue(source, destination);
  assertSelfContainedGlue(destination);
  glue.push({
    file: fileName,
    mode: "bundle",
    bytes: statSync(destination).size,
  });
}

removeExistingPackages(distNativeDir);

const packages = [];
const defaultPackagePath = join(distNativeDir, "native-pipeline.stlanonpkg");
buildCompressedPackage(["--out", defaultPackagePath, "--default-dictionaries"]);
packages.push(packageInfo(defaultPackagePath));

for (const language of scopedLanguages) {
  const scopedPackagePath = join(
    distNativeDir,
    `native-pipeline.${language}.stlanonpkg`,
  );
  buildCompressedPackage([
    "--out",
    scopedPackagePath,
    "--default-dictionaries",
    "--language",
    language,
  ]);
  packages.push(packageInfo(scopedPackagePath));
}

console.log(
  JSON.stringify(
    { event: "native-wasm-assets", distNativeDir, glue, packages },
    null,
    2,
  ),
);

function requireArtifact(fileName) {
  const source = join(wasmDistDir, fileName);
  if (!existsSync(source)) {
    throw new Error(`Missing wasm artifact: ${source}`);
  }
  return source;
}

/** Bundle a browser-targeted napi-rs glue entry so its bare
 * `@napi-rs/wasm-runtime` import (and that runtime's deps) is inlined. Runs
 * `bun build` from the package root so the runtime resolves from the package's
 * node_modules. `import.meta.url`-relative `new URL(...)` references (the
 * `.wasm` binary and the worker) are left intact by bun, so they keep resolving
 * to the sibling files emitted in `native/`. */
function bundleBrowserGlue(source, destination) {
  execFileSync(
    "bun",
    [
      "build",
      source,
      "--target=browser",
      "--format=esm",
      `--outfile=${destination}`,
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
}

/** Fail the build if a bundled browser glue file still carries a bare ESM
 * import/export specifier (e.g. an un-inlined `@napi-rs/wasm-runtime`). Such a
 * specifier would survive a consumer's raw-asset emit and break binding
 * instantiation in a production browser build. */
function assertSelfContainedGlue(filePath) {
  const code = readFileSync(filePath, "utf8");
  const bareSpecifier =
    /^\s*(?:import|export)\b[^\n]*?\bfrom\s*["'](?![./])([^"']+)["']/gm;
  const remaining = [...code.matchAll(bareSpecifier)].map((match) => match[1]);
  if (remaining.length > 0) {
    throw new Error(
      `Bundled browser glue ${basename(filePath)} still imports bare specifiers: ` +
        `${[...new Set(remaining)].join(", ")}. Bundling did not inline them.`,
    );
  }
}

function buildCompressedPackage(args) {
  execFileSync(
    process.execPath,
    [
      join(packageRoot, "scripts", "build-native-pipeline-package.mjs"),
      "--compressed",
      ...args,
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );
}

function packageInfo(packagePath) {
  return { file: basename(packagePath), bytes: statSync(packagePath).size };
}

function removeExistingPackages(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry.endsWith(".stlanonpkg")) {
      rmSync(join(directory, entry), { force: true });
    }
  }
}

function languageListFromEnv(value, defaultLanguages) {
  if (value === undefined) {
    return defaultLanguages;
  }
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}
