import { describe, expect, test } from "bun:test";

import type { NativeAnonymizeBinding } from "../native";
import {
  loadNativeAnonymizeBinding,
  nativePlatformPackageName,
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

  test("loads the platform package after the local loader", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding("1.5.0");
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: "1.5.0",
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "@stll/anonymize-darwin-arm64") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["../index.cjs", "@stll/anonymize-darwin-arm64"]);
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

  test("rejects mismatched native binding versions", () => {
    expect(() =>
      loadNativeAnonymizeBinding({
        expectedVersion: "1.5.0",
        platform: "darwin",
        arch: "arm64",
        env: {},
        requireModule: (specifier) => {
          if (specifier === "@stll/anonymize-darwin-arm64") {
            return fakeNativeBinding("1.4.0");
          }
          throw new Error("not found");
        },
      }),
    ).toThrow("does not match 1.5.0");
  });
});

const fakeNativeBinding = (version: string): NativeAnonymizeBinding => ({
  nativePackageVersion: () => version,
  NativePreparedSearch: {
    fromConfigJsonBytes: () => fakePreparedSearch(),
    fromPreparedPackageBytes: () => fakePreparedSearch(),
  },
  prepareStaticSearchPackageBytes: () => new Uint8Array(),
  prepareStaticSearchCompressedPackageBytes: () => new Uint8Array(),
});

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
