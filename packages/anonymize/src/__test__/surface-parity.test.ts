/**
 * Full public-surface parity contract.
 *
 * Behavioral fixture parity remains in the native SDK, Python, WASM, and DOCX
 * suites. This test closes the structural gap between those suites: every
 * public capability belongs to a named runtime profile, and every runtime in
 * that profile must expose an executable adapter for it. A new one-runtime
 * feature therefore fails here until its peer bindings land.
 */
import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilityRuntime,
  type CapabilitySurfaceId,
} from "../capabilities";
import * as native from "../native";
import * as nativeNode from "../native-node";
import * as wasm from "../wasm";

type RuntimeSurface = Record<CapabilitySurfaceId, unknown>;

const sessionPrototype = native.PreparedNativeRedactionSession?.prototype;
const preparedPrototype = native.PreparedNativeAnonymizer?.prototype;
const prototypeMethod = (
  prototype: object | undefined,
  name: string,
): unknown =>
  prototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(prototype, name)?.value;

const coreSurface = {
  "package.prepare": native.prepare_search_package,
  "package.load": native.load_prepared_package,
  "text.normalize": native.normalize_for_search,
  "text.redact": native.redact_text,
  "text.redact-stream": native.redact_text_stream_json,
  "text.diagnostics": native.diagnostics_json,
  "text.summary-diagnostics": native.summary_diagnostics_json,
  "text.caller-detections": prototypeMethod(
    preparedPrototype,
    "redact_text_with_caller_detections",
  ),
  "text.operators": prototypeMethod(preparedPrototype, "redact_text"),
  "package.default": nativeNode.getDefaultNativePipeline,
} as const;

const nodeSurface = {
  ...coreSurface,
  "package.load-file": nativeNode.load_prepared_package_file,
  "text.external-detection-batch": nativeNode.convert_external_detection_batch,
  "session.cross-document": prototypeMethod(
    preparedPrototype,
    "createRedactionSession",
  ),
  "session.lifecycle": prototypeMethod(
    preparedPrototype,
    "createRedactionSessionWithLifecycle",
  ),
  "session.plaintext-transfer": prototypeMethod(
    sessionPrototype,
    "toPlaintextJson",
  ),
  "session.encrypted-archive": prototypeMethod(
    sessionPrototype,
    "toEncryptedArchive",
  ),
} satisfies Partial<RuntimeSurface>;

const wasmSurface = {
  "package.prepare": wasm.prepare_search_package,
  "package.load": wasm.load_prepared_package,
  "text.normalize": wasm.normalize_for_search,
  "text.redact": wasm.redact_text,
  "text.redact-stream": wasm.redact_text_stream_json,
  "text.diagnostics": wasm.diagnostics_json,
  "text.summary-diagnostics": wasm.summary_diagnostics_json,
  "text.caller-detections": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "redact_text_with_caller_detections",
  ),
  "text.external-detection-batch": wasm.convert_external_detection_batch,
  "text.operators": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "redact_text",
  ),
  "package.default": wasm.loadDefaultPipeline,
  "session.cross-document": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "createRedactionSession",
  ),
  "session.lifecycle": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "createRedactionSessionWithLifecycle",
  ),
  "session.plaintext-transfer": prototypeMethod(
    wasm.PreparedNativeRedactionSession?.prototype,
    "toPlaintextJson",
  ),
  "session.encrypted-archive": prototypeMethod(
    wasm.PreparedNativeRedactionSession?.prototype,
    "toEncryptedArchive",
  ),
} satisfies Partial<RuntimeSurface>;

const runtimeSurfaces = {
  node: nodeSurface,
  wasm: wasmSurface,
} as const satisfies Partial<
  Record<CapabilityRuntime, Partial<RuntimeSurface>>
>;

describe("full runtime surface parity", () => {
  for (const runtime of ["node", "wasm"] as const) {
    test(`${runtime} exposes every surface in its parity profiles`, () => {
      const implemented: Partial<RuntimeSurface> = runtimeSurfaces[runtime];
      const expected = CAPABILITY_SURFACES.filter(
        ({ profile }) =>
          profile !== "document" &&
          CAPABILITY_PARITY_PROFILES[profile].some(
            (candidate) => candidate === runtime,
          ),
      );

      for (const { id } of expected) {
        expect(typeof implemented[id]).toBe("function");
      }
    });
  }
});
