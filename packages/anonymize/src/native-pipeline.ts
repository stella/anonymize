import {
  buildNativeStaticSearchBundle,
  type NativePreparedSearchConfig,
} from "./build-unified-search";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";
import { applyPipelineLanguageScope } from "./language-scope";
import { pipelineConfigKey } from "./pipeline-cache-key";
import type { Dictionaries, GazetteerEntry, PipelineConfig } from "./types";
import {
  createNativePipelineFromPackage,
  prepareNativeSearchPackage,
  PreparedNativePipeline,
  type NativeAnonymizeBinding,
} from "./native";

export {
  PreparedNativePipeline,
  createNativePipelineFromPackage,
} from "./native";

export type NativePipelineUnsupportedFeature = "enableNer" | "enableNameCorpus";

export type NativePipelineCompatibility =
  | { status: "supported" }
  | {
      status: "unsupported";
      unsupportedFeatures: NativePipelineUnsupportedFeature[];
    };

export type NativePipelineBuildOptions = {
  binding: NativeAnonymizeBinding;
  config: PipelineConfig;
  gazetteerEntries?: GazetteerEntry[];
  context?: PipelineContext;
};

export type NativePipelinePackageOptions = NativePipelineBuildOptions & {
  compressed?: boolean;
};

export type { NativePipelineFromPackageOptions } from "./native";

type NativePipelinePackageCacheValue = Promise<Uint8Array> | Uint8Array;

const sharedPackageByDictionaries = new WeakMap<
  Dictionaries,
  Map<string, NativePipelinePackageCacheValue>
>();
const sharedPackageWithoutDictionaries = new Map<
  string,
  NativePipelinePackageCacheValue
>();

const sharedPackageCacheFor = (
  dictionaries: Dictionaries | undefined,
): Map<string, NativePipelinePackageCacheValue> => {
  if (dictionaries === undefined) {
    return sharedPackageWithoutDictionaries;
  }
  const cached = sharedPackageByDictionaries.get(dictionaries);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, NativePipelinePackageCacheValue>();
  sharedPackageByDictionaries.set(dictionaries, created);
  return created;
};

export const getNativePipelineCompatibility = (
  config: PipelineConfig,
): NativePipelineCompatibility => {
  const unsupportedFeatures: NativePipelineUnsupportedFeature[] = [];

  if (config.enableNer) unsupportedFeatures.push("enableNer");
  if (config.enableNameCorpus && !config.enableDenyList) {
    unsupportedFeatures.push("enableNameCorpus");
  }
  if (unsupportedFeatures.length === 0) {
    return { status: "supported" };
  }
  return { status: "unsupported", unsupportedFeatures };
};

export const assertNativePipelineSupported = (config: PipelineConfig): void => {
  const compatibility = getNativePipelineCompatibility(config);
  if (compatibility.status === "supported") {
    return;
  }
  throw new Error(
    `Native pipeline does not yet support: ${compatibility.unsupportedFeatures.join(", ")}`,
  );
};

export const prepareNativePipelineConfig = async ({
  config,
  gazetteerEntries = [],
  context,
}: Omit<
  NativePipelineBuildOptions,
  "binding"
>): Promise<NativePreparedSearchConfig> => {
  assertNativePipelineSupported(config);
  const bundle = await buildNativeStaticSearchBundle(
    config,
    gazetteerEntries,
    context ?? defaultContext,
  );
  return bundle.nativeStaticConfig;
};

export const prepareNativePipelinePackage = async ({
  binding,
  config,
  gazetteerEntries = [],
  context,
  compressed = true,
}: NativePipelinePackageOptions): Promise<Uint8Array> => {
  const packageBytes = await getCachedNativePipelinePackage({
    config,
    binding,
    gazetteerEntries,
    ...(context ? { context } : {}),
    compressed,
  });
  return packageBytes.slice();
};

export const createNativePipelineFromConfig = async ({
  binding,
  config,
  gazetteerEntries = [],
  context,
}: NativePipelineBuildOptions): Promise<PreparedNativePipeline> => {
  const packageBytes = await getCachedNativePipelinePackage({
    binding,
    config,
    gazetteerEntries,
    ...(context ? { context } : {}),
  });
  return createNativePipelineFromPackage({ binding, packageBytes });
};

const getCachedNativePipelinePackage = async ({
  binding,
  config,
  gazetteerEntries = [],
  context,
  compressed = true,
}: NativePipelinePackageOptions): Promise<Uint8Array> => {
  const scopedConfig = applyPipelineLanguageScope(config);
  assertNativePipelineSupported(scopedConfig);
  const ctx = context ?? defaultContext;
  const key = nativePackageCacheKey({
    binding,
    config: scopedConfig,
    gazetteerEntries,
    compressed,
  });
  if (ctx.nativePipelinePackage && ctx.nativePipelinePackageKey === key) {
    return ctx.nativePipelinePackage;
  }
  if (
    ctx.nativePipelinePackagePromise &&
    ctx.nativePipelinePackageKey === key
  ) {
    return ctx.nativePipelinePackagePromise;
  }

  const sharedCache = sharedPackageCacheFor(scopedConfig.dictionaries);
  const shared = sharedCache.get(key);
  if (shared !== undefined) {
    const packageBytes = await shared;
    ctx.nativePipelinePackage = packageBytes;
    ctx.nativePipelinePackageKey = key;
    ctx.nativePipelinePackagePromise = null;
    return packageBytes;
  }

  ctx.nativePipelinePackage = null;
  ctx.nativePipelinePackageKey = key;
  const promise = buildNativePipelinePackage({
    binding,
    config: scopedConfig,
    gazetteerEntries,
    context: ctx,
    compressed,
  });
  ctx.nativePipelinePackagePromise = promise;
  sharedCache.set(key, promise);
  let packageBytes: Uint8Array;
  try {
    packageBytes = await promise;
  } catch (error) {
    if (sharedCache.get(key) === promise) {
      sharedCache.delete(key);
    }
    throw error;
  }
  if (sharedCache.get(key) === promise) {
    sharedCache.set(key, packageBytes);
  }
  if (ctx.nativePipelinePackageKey === key) {
    ctx.nativePipelinePackage = packageBytes;
    ctx.nativePipelinePackagePromise = null;
  }
  return packageBytes;
};

const buildNativePipelinePackage = async ({
  binding,
  config,
  gazetteerEntries,
  context,
  compressed,
}: Required<NativePipelinePackageOptions>): Promise<Uint8Array> => {
  const bundle = await buildNativeStaticSearchBundle(
    config,
    gazetteerEntries,
    context,
  );
  return prepareNativeSearchPackage({
    binding,
    config: bundle.nativeStaticConfig,
    compressed,
  });
};

type NativePackageCacheKeyOptions = {
  binding: NativeAnonymizeBinding;
  config: PipelineConfig;
  gazetteerEntries: readonly GazetteerEntry[];
  compressed: boolean;
};

const nativePackageCacheKey = ({
  binding,
  config,
  gazetteerEntries,
  compressed,
}: NativePackageCacheKeyOptions): string =>
  [
    binding.nativePackageVersion(),
    compressed ? "compressed" : "raw",
    pipelineConfigKey(config, gazetteerEntries),
  ].join(":");
