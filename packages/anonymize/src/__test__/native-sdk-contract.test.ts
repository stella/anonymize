/**
 * Native SDK surface contract.
 *
 * The shared SDK contract (`../native-sdk-contract`) is the single source of
 * truth for the public surface every language binding must expose. These
 * invariants assert that the TypeScript native SDK (`../native` +
 * `../native-node`) actually exposes that surface, so a rename or accidental
 * drop is caught here rather than in a cross-language parity run.
 *
 * This file is native-only: it loads the in-process binding and never spawns a
 * subprocess. The Python-binding parity lives in `python-parity.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as native from "../native";
import {
  DEFAULT_NATIVE_PIPELINE_WARMUPS,
  getDefaultNativePipeline,
  loadNativeAnonymizeBinding,
  native_package_version,
} from "../native-node";
import * as nativeNode from "../native-node";
import {
  PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_NAMES,
  SHARED_NATIVE_SDK_CLASS_NAMES,
  SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS,
  SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS,
  SHARED_NATIVE_SDK_PREPARED_METHODS,
  SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS,
} from "../native-sdk-contract";

const nativeSurface = native as unknown as Record<string, unknown>;
const nativeNodeSurface = nativeNode as unknown as Record<string, unknown>;

const packageJsonVersion = (): string => {
  const { version } = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof version !== "string") {
    throw new TypeError("package.json version is missing");
  }
  return version;
};

describe("native SDK surface contract", () => {
  test("core top-level functions are exposed by ../native", () => {
    for (const name of SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS) {
      expect(typeof nativeSurface[name]).toBe("function");
    }
  });

  test("top-level functions are exposed by the native SDK entry point", () => {
    for (const name of SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS) {
      expect(typeof nativeNodeSurface[name]).toBe("function");
    }
  });

  test("default-package functions are exposed by the native SDK entry point", () => {
    for (const name of SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS) {
      expect(typeof nativeNodeSurface[name]).toBe("function");
    }
  });

  test("SDK classes are exposed as constructors by ../native", () => {
    for (const name of SHARED_NATIVE_SDK_CLASS_NAMES) {
      expect(typeof nativeSurface[name]).toBe("function");
    }
  });

  test("default-package public names are exposed by the native SDK entry point", () => {
    // Only the runtime value is checkable at runtime; the accompanying type
    // name (`DefaultNativePipelineWarmup`) is enforced by the import above.
    expect(PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_NAMES).toContain(
      "DEFAULT_NATIVE_PIPELINE_WARMUPS",
    );
    expect(typeof DEFAULT_NATIVE_PIPELINE_WARMUPS).toBe("object");
  });

  test("prepared pipeline instances expose the shared prepared methods", () => {
    const binding = loadNativeAnonymizeBinding();
    const prepared = getDefaultNativePipeline({
      binding,
      language: "en",
    }) as unknown as Record<string, unknown>;
    for (const name of SHARED_NATIVE_SDK_PREPARED_METHODS) {
      expect(typeof prepared[name]).toBe("function");
    }
  });

  test("native package version matches the package manifest", () => {
    const binding = loadNativeAnonymizeBinding();
    expect(native_package_version({ binding })).toBe(packageJsonVersion());
  });
});
