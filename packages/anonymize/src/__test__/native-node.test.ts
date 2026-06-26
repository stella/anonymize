import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeAnonymizeBinding } from "../native";
import {
  createNativePipelineFromDefaultPackage,
  createNativePipelineFromPackageFile,
  diagnostics_json,
  getDefaultNativePipeline,
  load_prepared_package,
  load_prepared_package_file,
  loadNativeAnonymizeBinding,
  native_package_version,
  normalize_for_search,
  preloadDefaultNativePipeline,
  prepare_search_package,
  readNativePipelinePackageFile,
  redact_text_json,
} from "../native-node";

describe("native node loader", () => {
  test("loads the bundled native loader", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding("1.5.0");
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: "1.5.0",
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "../index.cjs") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["../index.cjs"]);
  });

  test("loads an explicit native library path first", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding("1.5.0");
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: "1.5.0",
      env: { STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH: "/tmp/anonymize.node" },
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "/tmp/anonymize.node") {
          return { default: binding };
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["/tmp/anonymize.node"]);
  });

  test("accepts a napi class constructor on the native binding", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding("1.5.0", {
      preparedSearchAsConstructor: true,
    });
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: "1.5.0",
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "../index.cjs") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
  });

  test("rejects mismatched native binding versions", () => {
    expect(() =>
      loadNativeAnonymizeBinding({
        expectedVersion: "1.5.0",
        platform: "darwin",
        arch: "arm64",
        env: {},
        requireModule: (specifier) => {
          if (specifier === "../index.cjs") {
            return fakeNativeBinding("1.4.0");
          }
          throw new Error("not found");
        },
      }),
    ).toThrow("does not match 1.5.0");
  });

  test("loads native pipeline package bytes from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-package-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(1, 2, 3, 4));

      expect([...readNativePipelinePackageFile(packagePath)]).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a native pipeline from a package file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-pipeline-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(7, 8, 9));
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytes: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const pipeline = createNativePipelineFromPackageFile({
        binding,
        expectedVersion: "1.5.0",
        packagePath,
      });

      expect(capturedBytes).toEqual([[7, 8, 9]]);
      expect(pipeline.redactText("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a native pipeline from the default package path override", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-pipeline-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(10, 11, 12));
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytes: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const pipeline = createNativePipelineFromDefaultPackage({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });

      expect(capturedBytes).toEqual([[10, 11, 12]]);
      expect(pipeline.redactText("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caches the default native pipeline per binding and package path", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-cache-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(13, 14, 15));
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytes: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const first = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });
      const second = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });
      const preloaded = preloadDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });

      expect(second).toBe(first);
      expect(preloaded).toBe(first);
      expect(capturedBytes).toEqual([[13, 14, 15]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shared SDK helpers delegate through the native binding", () => {
    const capturedBytes: number[][] = [];
    const binding = fakeNativeBinding("1.5.0", {
      compressedPackageBytes: Uint8Array.of(21, 22, 23),
      onPreparedPackageBytes: (bytes) => {
        capturedBytes.push([...bytes]);
      },
    });

    expect(native_package_version({ binding })).toBe("1.5.0");
    expect(normalize_for_search("Číslo", { binding })).toBe("Číslo");

    const packageBytes = prepare_search_package("{}", { binding });
    expect([...packageBytes]).toEqual([21, 22, 23]);

    const prepared = load_prepared_package(packageBytes, { binding });
    expect(capturedBytes).toEqual([[21, 22, 23]]);
    expect(prepared.redact_text("x").redaction.redactedText).toBe("");
    const expectedJson = {
      redaction: {
        entity_count: 0,
        operator_map: [],
        redacted_text: "",
        redaction_map: [],
      },
      resolved_entities: [],
    };
    expect(JSON.parse(prepared.redact_text_json("x"))).toEqual(expectedJson);
    expect(
      JSON.parse(redact_text_json("{}", "x", undefined, { binding })),
    ).toEqual(expectedJson);
    expect(
      JSON.parse(diagnostics_json("{}", "x", undefined, { binding }) ?? "{}"),
    ).toEqual({
      diagnostics: { events: [] },
      result: expectedJson,
    });

    const dir = mkdtempSync(join(tmpdir(), "anonymize-shared-sdk-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, packageBytes);
      const fromFile = load_prepared_package_file(packagePath, { binding });
      expect(fromFile.redact_text("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const emptyStaticRedactionBindingResult = () => ({
  resolvedEntities: [],
  redaction: {
    redactedText: "",
    redactionMap: [],
    operatorMap: [],
    entityCount: 0,
  },
});

const emptyStaticRedactionDiagnosticJson = (): string =>
  JSON.stringify({
    diagnostics: { events: [] },
    result: {
      redaction: {
        entity_count: 0,
        operator_map: [],
        redacted_text: "",
        redaction_map: [],
      },
      resolved_entities: [],
    },
  });

type FakeNativeBindingOptions = {
  preparedSearchAsConstructor?: boolean;
  compressedPackageBytes?: Uint8Array;
  onPreparedPackageBytes?: (bytes: Uint8Array) => void;
};

const fakeNativeBinding = (
  version: string,
  options: FakeNativeBindingOptions = {},
): NativeAnonymizeBinding => {
  const preparedSearch = {
    fromConfigJsonBytes: () => fakePreparedSearch(),
    fromPreparedPackageBytes: (bytes: Uint8Array) => {
      options.onPreparedPackageBytes?.(bytes);
      return fakePreparedSearch();
    },
  };
  const NativePreparedSearch = options.preparedSearchAsConstructor
    ? Object.assign(function NativePreparedSearch() {}, preparedSearch)
    : preparedSearch;

  return {
    normalizeForSearch: (text: string) => text,
    nativePackageVersion: () => version,
    NativePreparedSearch,
    prepareStaticSearchPackageBytes: () => new Uint8Array(),
    prepareStaticSearchCompressedPackageBytes: () =>
      options.compressedPackageBytes ?? new Uint8Array(),
  };
};

const fakePreparedSearch = () => ({
  prepareDiagnosticsJson: () => JSON.stringify({ events: [] }),
  redactStaticEntities: emptyStaticRedactionBindingResult,
  redactStaticEntitiesDiagnosticsJson: emptyStaticRedactionDiagnosticJson,
});
