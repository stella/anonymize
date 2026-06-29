import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NativeAnonymizeBinding } from "../native";
import {
  create_native_pipeline_from_default_package,
  createNativePipelineFromDefaultPackage,
  createNativePipelineFromPackageFile,
  diagnostics_json,
  get_default_native_pipeline,
  getDefaultNativePipeline,
  load_prepared_package,
  load_prepared_package_file,
  loadNativeAnonymizeBinding,
  native_package_version,
  normalize_for_search,
  preload_default_native_pipeline,
  preloadDefaultNativePipeline,
  preloadDefaultNativePipelineAsync,
  prepare_search_package,
  read_default_native_pipeline_package_file,
  readDefaultNativePipelinePackageFile,
  readNativePipelinePackageFile,
  readNativePipelinePackageFileAsync,
  redact_text,
  redact_text_json,
} from "../native-node";
import {
  SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS,
  SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS,
} from "../native-sdk-contract";

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

  test("loads native pipeline package bytes from a file asynchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-package-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(4, 3, 2, 1));

      expect([
        ...(await readNativePipelinePackageFileAsync(packagePath)),
      ]).toEqual([4, 3, 2, 1]);
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
        onPreparedPackageBytesWithoutCache: (bytes) => {
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
      let warmCount = 0;
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
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
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("can defer default native pipeline warmup", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-warmup-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(19, 20, 21));
      let warmCount = 0;
      const binding = fakeNativeBinding("1.5.0", {
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      const cold = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
        warmup: "none",
      });
      const stillCold = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
        warmup: "none",
      });
      const warmed = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });

      expect(stillCold).toBe(cold);
      expect(warmed).toBe(cold);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preloads the default native pipeline asynchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-async-cache-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(16, 17, 18));
      let warmCount = 0;
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      const [first, second] = await Promise.all([
        preloadDefaultNativePipelineAsync({
          binding,
          packagePath,
          expectedVersion: "1.5.0",
        }),
        preloadDefaultNativePipelineAsync({
          binding,
          packagePath,
          expectedVersion: "1.5.0",
        }),
      ]);
      const syncCached = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: "1.5.0",
      });

      expect(second).toBe(first);
      expect(syncCached).toBe(first);
      expect(capturedBytes).toEqual([[16, 17, 18]]);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads language-scoped default native pipeline packages", () => {
    const language = "zz-test";
    const packagePath = fileURLToPath(
      new URL(`../../native-pipeline.${language}.stlanonpkg`, import.meta.url),
    );
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(31, 32, 33));
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const first = getDefaultNativePipeline({
        binding,
        language: "ZZ-Test",
        expectedVersion: "1.5.0",
      });
      const second = getDefaultNativePipeline({
        binding,
        language,
        expectedVersion: "1.5.0",
      });

      expect(second).toBe(first);
      expect(capturedBytes).toEqual([[31, 32, 33]]);
    } finally {
      rmSync(packagePath, { force: true });
    }
  });

  test("shared default package SDK helpers expose snake-case aliases", () => {
    const aliasFunctions: Record<
      (typeof SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS)[number],
      unknown
    > = {
      create_native_pipeline_from_default_package,
      get_default_native_pipeline,
      preload_default_native_pipeline,
      read_default_native_pipeline_package_file,
    };
    for (const name of SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS) {
      expect(typeof aliasFunctions[name]).toBe("function");
    }

    const language = "zz-alias";
    const languagePackagePath = fileURLToPath(
      new URL(`../../native-pipeline.${language}.stlanonpkg`, import.meta.url),
    );
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-alias-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(languagePackagePath, Uint8Array.of(41, 42, 43));
      writeFileSync(packagePath, Uint8Array.of(44, 45, 46));
      let warmCount = 0;
      const binding = fakeNativeBinding("1.5.0", {
        onPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      expect([
        ...read_default_native_pipeline_package_file({ language }),
      ]).toEqual([41, 42, 43]);

      const created = create_native_pipeline_from_default_package({
        binding,
        packagePath,
        warmup: "none",
      });
      const cached = get_default_native_pipeline({
        binding,
        packagePath,
        warmup: "none",
      });
      const warmed = preload_default_native_pipeline({
        binding,
        packagePath,
      });

      expect(warmed).toBe(cached);
      expect(created).not.toBe(cached);
      expect(capturedBytes).toEqual([
        [44, 45, 46],
        [44, 45, 46],
      ]);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(languagePackagePath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsafe default native package language selectors", () => {
    expect(() =>
      readDefaultNativePipelinePackageFile({ language: "../en" }),
    ).toThrow("Default native pipeline language must match");
    expect(() =>
      getDefaultNativePipeline({
        binding: fakeNativeBinding("1.5.0"),
        language: "en",
        packagePath: "/tmp/native-pipeline.stlanonpkg",
      }),
    ).toThrow("Use either language or packagePath");
  });

  test("rejects unknown default native pipeline warmup modes", () => {
    const binding = fakeNativeBinding("1.5.0");

    expect(() =>
      Reflect.apply(getDefaultNativePipeline, undefined, [
        {
          binding,
          warmup: "eager",
        },
      ]),
    ).toThrow('Default native pipeline warmup must be "lazy-regex" or "none"');
  });

  test("shared SDK helpers delegate through the native binding", () => {
    const sharedSdkFunctions: Record<
      (typeof SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS)[number],
      unknown
    > = {
      diagnostics_json,
      load_prepared_package,
      load_prepared_package_file,
      native_package_version,
      normalize_for_search,
      prepare_search_package,
      redact_text,
      redact_text_json,
    };
    for (const name of SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS) {
      expect(typeof sharedSdkFunctions[name]).toBe("function");
    }

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
    expect(
      JSON.parse(prepared.warm_lazy_regex_diagnostics_json() ?? "{}"),
    ).toEqual({
      events: [],
    });
    expect(redact_text("{}", "x", undefined, { binding }).redaction).toEqual({
      entityCount: 0,
      operatorMap: new Map(),
      redactedText: "",
      redactionMap: new Map(),
    });
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

  test("prepared pipeline JSON methods use the native JSON hook", () => {
    let jsonCalls = 0;
    const binding = fakeNativeBinding("1.5.0", {
      onRedactStaticEntitiesJson: () => {
        jsonCalls += 1;
        return JSON.stringify({ marker: "native-json" });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "anonymize-json-pipeline-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(1, 2, 3));
      const pipeline = createNativePipelineFromDefaultPackage({
        binding,
        packagePath,
      });

      expect(JSON.parse(pipeline.redact_text_json("x"))).toEqual({
        marker: "native-json",
      });
      expect(JSON.parse(pipeline.redactTextJson("x"))).toEqual({
        marker: "native-json",
      });
      expect(jsonCalls).toBe(2);
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
  onPreparedPackageBytesWithoutCache?: (bytes: Uint8Array) => void;
  onRedactStaticEntitiesJson?: () => string;
  onWarmLazyRegex?: () => void;
};

const fakeNativeBinding = (
  version: string,
  options: FakeNativeBindingOptions = {},
): NativeAnonymizeBinding => {
  const preparedOptions = (): FakePreparedSearchOptions => ({
    ...(options.onRedactStaticEntitiesJson === undefined
      ? {}
      : { onRedactStaticEntitiesJson: options.onRedactStaticEntitiesJson }),
    ...(options.onWarmLazyRegex === undefined
      ? {}
      : { onWarmLazyRegex: options.onWarmLazyRegex }),
  });
  const preparedSearch = {
    fromConfigJsonBytes: () => fakePreparedSearch(preparedOptions()),
    fromPreparedPackageBytes: (bytes: Uint8Array) => {
      options.onPreparedPackageBytes?.(bytes);
      return fakePreparedSearch(preparedOptions());
    },
    fromPreparedPackageBytesWithoutCache: (bytes: Uint8Array) => {
      options.onPreparedPackageBytesWithoutCache?.(bytes);
      return fakePreparedSearch(preparedOptions());
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

type FakePreparedSearchOptions = {
  onRedactStaticEntitiesJson?: () => string;
  onWarmLazyRegex?: () => void;
};

const fakePreparedSearch = ({
  onRedactStaticEntitiesJson,
  onWarmLazyRegex,
}: FakePreparedSearchOptions) => ({
  prepareDiagnosticsJson: () => JSON.stringify({ events: [] }),
  warmLazyRegex: () => {
    onWarmLazyRegex?.();
  },
  warmLazyRegexDiagnosticsJson: () => JSON.stringify({ events: [] }),
  redactStaticEntities: emptyStaticRedactionBindingResult,
  ...(onRedactStaticEntitiesJson === undefined
    ? {}
    : { redactStaticEntitiesJson: onRedactStaticEntitiesJson }),
  redactStaticEntitiesDiagnosticsJson: emptyStaticRedactionDiagnosticJson,
});
