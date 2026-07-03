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
 *   - copies the wasm binding + WASI/browser glue + workers into
 *     `wasm/dist/native/`, next to the bundled `wasm.mjs` entry so its
 *     `new URL("./native/…", import.meta.url)` lookups resolve;
 *   - builds the LZ4-compressed default prepared package (and per-language
 *     variants) into the same directory for `loadDefaultPipeline()`.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmDistDir = join(packageRoot, "native-wasm-dist");
const distNativeDir = join(packageRoot, "wasm", "dist", "native");
const DEFAULT_SCOPED_PACKAGE_LANGUAGES = ["cs", "de", "en"];
const scopedLanguages = languageListFromEnv(
  process.env.STELLA_ANONYMIZE_WASM_PACKAGE_LANGUAGES,
  DEFAULT_SCOPED_PACKAGE_LANGUAGES,
);

// napi-rs glue + binary the runtime binding loader needs, in the same directory.
const GLUE_FILES = [
  "index.wasi.cjs",
  "index.wasi-browser.js",
  "index.wasm32-wasi.wasm",
  "wasi-worker.mjs",
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
const copied = [];
for (const fileName of GLUE_FILES) {
  const source = join(wasmDistDir, fileName);
  if (!existsSync(source)) {
    throw new Error(`Missing wasm artifact: ${source}`);
  }
  const destination = join(distNativeDir, fileName);
  copyFileSync(source, destination);
  copied.push({ file: fileName, bytes: statSync(destination).size });
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
    { event: "native-wasm-assets", distNativeDir, glue: copied, packages },
    null,
    2,
  ),
);

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
