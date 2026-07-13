/**
 * Smoke test for the WebAssembly build of the native binding.
 *
 * Proves the napi-rs `wasm32-wasip1` artifact in `native-wasm-dist/` loads and
 * runs end to end: the sequential (non-threaded) fallbacks in the Rust core are
 * exercised while preparing an engine from a package and while searching text.
 *
 * Build the artifact first with `bun run build:native-wasm`, and make sure
 * `native-pipeline.stlanonpkg` exists (produced by `bun run build`). Run with
 * Node (the loader relies on `node:wasi`): `node scripts/smoke-wasm.mjs`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const require = createRequire(import.meta.url);

const wasiBindingPath = join(packageRoot, "native-wasm-dist", "index.wasi.cjs");
const binding = require(wasiBindingPath);

const { NativePreparedSearch, nativePackageVersion, normalizeForSearch } =
  binding;

if (typeof NativePreparedSearch !== "function") {
  throw new TypeError("wasm binding is missing NativePreparedSearch");
}

const version = nativePackageVersion();
if (typeof version !== "string" || version.length === 0) {
  throw new Error("nativePackageVersion did not return a version string");
}

const normalized = normalizeForSearch("Ĥĕllo   WÖRLD");
if (typeof normalized !== "string" || normalized.length === 0) {
  throw new Error("normalizeForSearch did not return normalized text");
}

const packagePath = join(packageRoot, "native-pipeline.stlanonpkg");
const packageBytes = readFileSync(packagePath);
const prepared = NativePreparedSearch.fromPreparedPackageBytes(packageBytes);

if (
  typeof prepared.createRedactionSession !== "function" ||
  typeof prepared.restoreRedactionSession !== "function" ||
  typeof prepared.restoreEncryptedRedactionSession !== "function" ||
  typeof prepared.createRedactionSessionWithLifecycle !== "function"
) {
  throw new TypeError("wasm binding is missing redaction session factories");
}

const sample = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const result = prepared.redactStaticEntities(sample);
const entities = result.resolvedEntities;

if (!Array.isArray(entities) || entities.length === 0) {
  throw new Error("wasm pipeline did not detect any entity");
}

for (const entity of entities) {
  const { start, end, text } = entity;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > sample.length
  ) {
    throw new Error(
      `entity has out-of-range offsets: start=${start} end=${end} len=${sample.length}`,
    );
  }
  // Offsets are UTF-16 code units, so a JS slice must round-trip the entity text.
  if (sample.slice(start, end) !== text) {
    throw new Error(
      `entity offsets do not map to its text: [${start}, ${end}) => "${sample.slice(start, end)}" != "${text}"`,
    );
  }
}

const session = prepared.createRedactionSession("smoke_1");
const sessionResult = JSON.parse(session.redactStaticEntitiesJson(sample));
if (
  !Array.isArray(sessionResult.redaction?.redaction_map) ||
  sessionResult.redaction.redaction_map.length === 0 ||
  session.mappingCount() === 0
) {
  throw new Error("wasm redaction session did not retain any mapping");
}
const sessionState = session.toPlaintextJson();
const restoredSession = prepared.restoreRedactionSession(sessionState);
if (restoredSession.sessionId() !== "smoke_1") {
  throw new Error("wasm redaction session did not restore its identity");
}
const archiveKey = new Uint8Array(32).fill(0x42);
const encryptedArchive = session.toEncryptedArchive(archiveKey);
const encryptedRestoredSession = prepared.restoreEncryptedRedactionSession({
  archive: encryptedArchive,
  key: archiveKey,
  expectedSessionId: "smoke_1",
});
if (
  encryptedRestoredSession.sessionId() !== "smoke_1" ||
  encryptedRestoredSession.mappingCount() !== session.mappingCount()
) {
  throw new Error("wasm encrypted session archive did not round-trip");
}
const lifecycleSession = prepared.createRedactionSessionWithLifecycle(
  "lifecycle_smoke_1",
  100,
  200,
);
lifecycleSession.redactStaticEntitiesJsonAt(sample, 150);
const lifecycleArchive = lifecycleSession.toEncryptedArchiveAt(archiveKey, 150);
const restoredLifecycleSession = prepared.restoreEncryptedRedactionSession({
  archive: lifecycleArchive,
  key: archiveKey,
  expectedSessionId: "lifecycle_smoke_1",
  observedAtEpochSeconds: 150,
});
if (JSON.parse(restoredLifecycleSession.inspectJson(150)).status !== "active") {
  throw new Error("wasm encrypted lifecycle session did not round-trip");
}
const lifecycleMetadata = JSON.parse(lifecycleSession.inspectJson(200));
if (lifecycleMetadata.status !== "expired") {
  throw new Error("wasm lifecycle session did not expire at its boundary");
}
const deletion = JSON.parse(lifecycleSession.deleteJson());
if (deletion.deleted_mapping_count === 0) {
  throw new Error("wasm lifecycle deletion did not clear mappings");
}

console.log(
  JSON.stringify({
    event: "wasm-smoke",
    ok: true,
    nativeVersion: version,
    entityCount: entities.length,
    sessionMappingCount: session.mappingCount(),
    labels: entities.map((entity) => entity.label),
    firstEntity: {
      start: entities[0].start,
      end: entities[0].end,
      label: entities[0].label,
    },
  }),
);
