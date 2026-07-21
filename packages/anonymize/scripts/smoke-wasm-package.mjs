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
 * `loadDefaultPipeline()` resolves the bundled default package from a file:
 * URL (import.meta.url). Node's global fetch cannot read file: URLs, so
 * `toPackageBytes` now reads those through node:fs; this smoke exercises that
 * path here (previously it could only byte-load the default package).
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const entryPath = join(packageRoot, "wasm", "dist", "wasm.mjs");
const nativeNodeEntryPath = join(packageRoot, "dist", "native-node.mjs");
const defaultPackagePath = join(
  packageRoot,
  "wasm",
  "dist",
  "native",
  "native-pipeline.stlanonpkg",
);
const pdfFixturePath = join(
  packageRoot,
  "..",
  "..",
  "crates",
  "anonymize-pdf-core",
  "tests",
  "fixtures",
  "minimal-text.pdf",
);

for (const [label, path] of [
  ["package entry", entryPath],
  ["native Node entry", nativeNodeEntryPath],
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
// eslint-disable-next-line stll/no-dynamic-import-specifier
const nativeNodeEntry = await import(pathToFileURL(nativeNodeEntryPath).href);

const {
  getBinding,
  native_package_version: nativePackageVersion,
  loadPipeline,
  loadDefaultPipeline,
  deanonymise,
  defaultPackageUrl,
  CAPABILITY_MANIFEST,
  inspect_pdf_json: inspectPdfJson,
} = entry;

if (
  CAPABILITY_MANIFEST.schemaVersion !== 2 ||
  CAPABILITY_MANIFEST.entities.length === 0
) {
  throw new TypeError("wasm capability manifest is missing or invalid");
}

const binding = await getBinding();
if (typeof binding.nativePackageVersion !== "function") {
  throw new TypeError("getBinding() did not return a native binding");
}
if (typeof binding.inspectPdfJson !== "function") {
  throw new TypeError("getBinding() did not expose PDF inspection");
}

const pdfBytes = new Uint8Array(readFileSync(pdfFixturePath));
const nodeBinding = nativeNodeEntry.loadNativeAnonymizeBinding();
const nodePdfJson = nodeBinding.inspectPdfJson(pdfBytes);
const directPdfJson = binding.inspectPdfJson(pdfBytes);
const packagePdfJson = await inspectPdfJson(pdfBytes);
if (packagePdfJson !== directPdfJson || packagePdfJson !== nodePdfJson) {
  throw new Error("Node and WASI PDF inspection results are not exact");
}
const observationBatch = {
  version: 1,
  document: { sha256: createHash("sha256").update(pdfBytes).digest("hex") },
  provider: { id: "smoke", name: "Smoke renderer", version: "1.0.0" },
  pages: [
    {
      pageIndex: 0,
      widthPoints: 612,
      heightPoints: 792,
      text: "Public fixture",
      glyphs: [
        {
          start: 0,
          end: 14,
          bounds: { left: 72, bottom: 700, right: 108, top: 712 },
          source: "embedded-text",
        },
      ],
      rendered: true,
      textLayer: "complete",
      ocr: "complete",
      imageCount: 0,
    },
  ],
};
const observationJson = JSON.stringify(observationBatch);
const observedResults = await Promise.all([
  nodeBinding.inspectPdfJson(pdfBytes, observationJson),
  binding.inspectPdfJson(pdfBytes, observationJson),
  inspectPdfJson(pdfBytes, observationJson),
]);
if (new Set(observedResults).size !== 1) {
  throw new Error("Node and WASI observed PDF results are not exact");
}
for (const invalid of [
  { ...observationBatch, document: { sha256: "0".repeat(64) } },
  { ...observationBatch, unknown: true },
]) {
  const invalidJson = JSON.stringify(invalid);
  const messages = [];
  for (const invoke of [
    () => nodeBinding.inspectPdfJson(pdfBytes, invalidJson),
    () => binding.inspectPdfJson(pdfBytes, invalidJson),
    () => inspectPdfJson(pdfBytes, invalidJson),
  ]) {
    let message;
    try {
      await invoke();
    } catch (error) {
      message = String(error?.message ?? error);
    }
    if (!message) throw new Error("invalid PDF observation batch was accepted");
    messages.push(message);
  }
  if (new Set(messages).size !== 1) {
    throw new Error("Node and WASI PDF observation errors are not exact");
  }
}
let directPdfError;
let packagePdfError;
try {
  binding.inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  directPdfError = String(error?.message ?? error);
}
let nodePdfError;
try {
  nodeBinding.inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  nodePdfError = String(error?.message ?? error);
}
try {
  await inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  packagePdfError = String(error?.message ?? error);
}
if (
  !directPdfError ||
  packagePdfError !== directPdfError ||
  nodePdfError !== directPdfError
) {
  throw new Error("Node and WASI PDF inspection error behavior is not exact");
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
      `entity offsets do not round-trip: [${start}, ${end}) => "${sample.slice(
        start,
        end,
      )}" != "${text}"`,
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

// loadDefaultPipeline() resolves the bundled package from its file: URL, which
// now reads through node:fs under Node. It must detect the same entities as the
// explicitly byte-loaded pipeline above.
const defaultPipeline = await loadDefaultPipeline();
const defaultEntities = defaultPipeline.redactText(sample).resolvedEntities;
if (!Array.isArray(defaultEntities) || defaultEntities.length === 0) {
  throw new Error("loadDefaultPipeline() did not detect any entity");
}
if (defaultEntities.length !== entities.length) {
  throw new Error(
    `loadDefaultPipeline() entity count ${defaultEntities.length} != byte-loaded ${entities.length}`,
  );
}

// Regional locale tags fall back to the shipped base-language package: no
// en-us package is bundled, so this must load native-pipeline.en.stlanonpkg.
const regionalPipeline = await loadDefaultPipeline("en-US");
if (regionalPipeline.redactText(sample).resolvedEntities.length === 0) {
  throw new Error("loadDefaultPipeline('en-US') did not fall back to en");
}

console.log(
  JSON.stringify({
    event: "wasm-package-smoke",
    ok: true,
    nativeVersion: version,
    entityCount: entities.length,
    labels: entities.map((entity) => entity.label),
    deanonymiseRoundTrip: true,
    loadDefaultPipeline: true,
    regionalLanguageFallback: true,
    pdfInspectionParity: true,
  }),
);
