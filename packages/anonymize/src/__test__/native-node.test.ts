import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeAnonymizeBinding } from "../native";
import {
  createNativePipelineFromPackageFile,
  loadNativeAnonymizeBinding,
  nativePlatformPackageName,
  readNativePipelinePackageFile,
} from "../native-node";

describe("native node loader", () => {
  test("maps supported platform package names", () => {
    expect(
      nativePlatformPackageName({ platform: "darwin", arch: "arm64" }),
    ).toBe("@stll/anonymize-darwin-arm64");
    expect(nativePlatformPackageName({ platform: "darwin", arch: "x64" })).toBe(
      "@stll/anonymize-darwin-x64",
    );
    expect(nativePlatformPackageName({ platform: "linux", arch: "x64" })).toBe(
      "@stll/anonymize-linux-x64-gnu",
    );
    expect(
      nativePlatformPackageName({ platform: "linux", arch: "arm64" }),
    ).toBe("@stll/anonymize-linux-arm64-gnu");
    expect(nativePlatformPackageName({ platform: "win32", arch: "x64" })).toBe(
      "@stll/anonymize-win32-x64-msvc",
    );
    expect(
      nativePlatformPackageName({
        platform: "linux",
        arch: "x64",
        libc: "musl",
      }),
    ).toBeNull();
  });

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
});

type FakeNativeBindingOptions = {
  preparedSearchAsConstructor?: boolean;
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
    nativePackageVersion: () => version,
    NativePreparedSearch,
    prepareStaticSearchPackageBytes: () => new Uint8Array(),
    prepareStaticSearchCompressedPackageBytes: () => new Uint8Array(),
  };
};

const fakePreparedSearch = () => ({
  redactStaticEntities: () => ({
    resolvedEntities: [],
    redaction: {
      redactedText: "",
      redactionMap: [],
      operatorMap: [],
      entityCount: 0,
    },
  }),
});
