/**
 * Smoke test against the built artifact. The regression suite
 * imports from src, so it cannot see failures that only exist in
 * the bundled output (e.g. an import the bundler could not
 * resolve). This script imports the published entrypoints the way a
 * package consumer does and fails when the native package path is not
 * usable from the built output.
 *
 * Run after `bun run build`: `bun run smoke:dist`.
 */
import { getDefaultNativePipeline, redactDefaultText } from "../dist/index.mjs";
import { CAPABILITY_MANIFEST } from "../dist/capabilities.mjs";
import { createNativeAnonymizerFromPackage } from "../dist/native.mjs";
import {
  createNativePipelineFromDefaultPackage,
  createNativePipelineFromPackageFile,
  loadNativeAnonymizeBinding,
} from "../dist/native-node.mjs";

if (typeof createNativeAnonymizerFromPackage !== "function") {
  throw new TypeError("dist native entrypoint is missing its package loader");
}
if (typeof loadNativeAnonymizeBinding !== "function") {
  throw new TypeError("dist native-node entrypoint is missing its loader");
}
if (typeof createNativePipelineFromPackageFile !== "function") {
  throw new TypeError("dist native-node entrypoint is missing file loading");
}
if (typeof createNativePipelineFromDefaultPackage !== "function") {
  throw new TypeError(
    "dist native-node entrypoint is missing default package loading",
  );
}
if (typeof getDefaultNativePipeline !== "function") {
  throw new TypeError(
    "dist root entrypoint is missing default pipeline loader",
  );
}
if (typeof redactDefaultText !== "function") {
  throw new TypeError(
    "dist root entrypoint is missing native redaction helper",
  );
}
if (
  CAPABILITY_MANIFEST.schemaVersion !== 1 ||
  CAPABILITY_MANIFEST.entities.length === 0
) {
  throw new TypeError("dist capability manifest is missing or invalid");
}

const nativePipeline = createNativePipelineFromDefaultPackage();
const nativeResult = nativePipeline.redactText(
  "A contract was signed by Jan Novak at Praha on 1. 1. 2025.",
);
if (nativeResult.resolvedEntities.length === 0) {
  throw new Error("default native pipeline package did not detect any entity");
}

console.log(
  JSON.stringify({
    event: "dist-smoke",
    ok: true,
    nativeEntityCount: nativeResult.resolvedEntities.length,
  }),
);
