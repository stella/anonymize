/**
 * Smoke test for the @stll/anonymize-wasm PACKAGE ENTRY (not just the raw
 * binding): exercises the built `wasm/dist/wasm.mjs` under Node's WASI runtime.
 *
 * Proves the new native-SDK surface works end to end: lazy `getBinding()` picks
 * the Node WASI glue, a compressed prepared package is byte-loaded into a
 * pipeline, `redactText` round-trips offsets, and `deanonymise` restores the
 * original text from the redaction map.
 *
 * Prerequisites:
 *   - `bun run build:native-wasm`        (produces native-wasm-dist/)
 *   - `bun run build`                    (produces wasm/dist/wasm.mjs)
 *   - `bun run build:wasm-assets`        (assembles wasm/dist/native/)
 *
 * `loadDefaultPipeline()` (fetch-based) is validated in the browser; Node's
 * global fetch does not support file: URLs, so here we byte-load instead and
 * only assert the bundled default package URL resolves to a real file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const entryPath = join(packageRoot, "wasm", "dist", "wasm.mjs");
const defaultPackagePath = join(
  packageRoot,
  "wasm",
  "dist",
  "native",
  "native-pipeline.stlanonpkg",
);

for (const [label, path] of [
  ["package entry", entryPath],
  ["default package", defaultPackagePath],
]) {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${label}: ${path}. Run "bun run build:native-wasm", "bun run build", then "bun run build:wasm-assets".`,
    );
  }
}

// eslint-disable-next-line stll/no-dynamic-import-specifier
const entry = await import(pathToFileURL(entryPath).href);

const {
  getBinding,
  native_package_version: nativePackageVersion,
  loadPipeline,
  deanonymise,
  defaultPackageUrl,
} = entry;

const binding = await getBinding();
if (typeof binding.nativePackageVersion !== "function") {
  throw new TypeError("getBinding() did not return a native binding");
}

const version = await nativePackageVersion();
if (typeof version !== "string" || version.length === 0) {
  throw new Error("native_package_version() did not return a version string");
}

// The bundled default package URL must resolve to a real file in the tarball.
const resolvedDefault = fileURLToPath(defaultPackageUrl());
if (!existsSync(resolvedDefault)) {
  throw new Error(
    `defaultPackageUrl() does not resolve to a file: ${resolvedDefault}`,
  );
}

const packageBytes = new Uint8Array(readFileSync(defaultPackagePath));
const pipeline = await loadPipeline(packageBytes);

const sample = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const result = pipeline.redactText(sample);
const entities = result.resolvedEntities;

if (!Array.isArray(entities) || entities.length === 0) {
  throw new Error("wasm package entry did not detect any entity");
}

for (const { start, end, text } of entities) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > sample.length ||
    sample.slice(start, end) !== text
  ) {
    throw new Error(
      `entity offsets do not round-trip: [${start}, ${end}) => "${sample.slice(start, end)}" != "${text}"`,
    );
  }
}

// Default operators are reversible ("replace"), so deanonymise must reconstruct
// the original text from the redaction map.
const { redactedText, redactionMap } = result.redaction;
if (redactedText === sample) {
  throw new Error("redaction did not change the text");
}
const restored = deanonymise(redactedText, redactionMap);
if (restored !== sample) {
  throw new Error(
    `deanonymise did not restore the original text:\n  restored: ${restored}\n  original: ${sample}`,
  );
}

console.log(
  JSON.stringify({
    event: "wasm-package-smoke",
    ok: true,
    nativeVersion: version,
    entityCount: entities.length,
    labels: entities.map((entity) => entity.label),
    deanonymiseRoundTrip: true,
  }),
);
