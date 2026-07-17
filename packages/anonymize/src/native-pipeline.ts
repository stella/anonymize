import type { PipelineContext } from "./context";
import { defaultContext } from "./context";
import { applyPipelineLanguageScope } from "./language-scope";
import type { NativePreparedSearchConfig } from "./native-search-config";
import { pipelineConfigKey } from "./pipeline-cache-key";
import type { Dictionaries, GazetteerEntry, PipelineConfig } from "./types";
import {
  createNativePipelineFromPackage,
  PreparedNativePipeline,
  type NativeAnonymizeBinding,
} from "./native";

export {
  PreparedNativePipeline,
  createNativePipelineFromPackage,
} from "./native";

export type NativePipelineUnsupportedFeature = "enableNer";

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

// Bounds each shared package cache (the dictionary-less bucket below, and
// each per-`Dictionaries` bucket handed out by `sharedPackageCacheFor`) to a
// fixed number of entries. `nativePackageCacheKey` fingerprints
// caller-suppliable config (custom deny lists, custom regexes, gazetteer
// entries) via `pipelineConfigKey`, so without a cap a caller that varies
// those fields grows a bucket — and the multi-MB assembled packages it
// holds — without limit.
export const SHARED_PACKAGE_CACHE_MAX_ENTRIES = 32;

const sharedPackageByDictionaries = new WeakMap<
  Dictionaries,
  Map<string, NativePipelinePackageCacheValue>
>();
const sharedPackageWithoutDictionaries = new Map<
  string,
  NativePipelinePackageCacheValue
>();
const dictionaryCacheIds = new WeakMap<Dictionaries, number>();
let nextDictionaryCacheId = 0;

/** Record `key` as most-recently-used in `cache`, evicting the
 * least-recently-used entry first once the cache is at capacity. A `Map`'s
 * insertion order doubles as recency order here: touching an existing key
 * deletes then re-sets it to move it to the end, and eviction drops the
 * first (oldest) key.
 *
 * Evicting a still-in-flight build only drops the cache's reference to its
 * promise; the caller that started the build (and any concurrent caller that
 * already read the promise before eviction) still resolves it correctly via
 * the guarded `sharedCache.get(key) === promise` checks in
 * `getCachedNativePipelinePackage`. A later caller for the same key just
 * misses the dedupe and starts a fresh build — bounded memory takes priority
 * over perfect dedupe under cache pressure. */
const touchSharedPackageCacheEntry = (
  cache: Map<string, NativePipelinePackageCacheValue>,
  key: string,
  value: NativePipelinePackageCacheValue,
): void => {
  cache.delete(key);
  if (cache.size >= SHARED_PACKAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
};

const dictionaryCacheKey = (dictionaries: Dictionaries | undefined): string => {
  if (dictionaries === undefined) {
    return "none";
  }
  const existing = dictionaryCacheIds.get(dictionaries);
  if (existing !== undefined) {
    return `dict:${existing}`;
  }
  nextDictionaryCacheId += 1;
  dictionaryCacheIds.set(dictionaries, nextDictionaryCacheId);
  return `dict:${nextDictionaryCacheId}`;
};

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

const encoder = new TextEncoder();

type AssembleInputs = {
  pipelineConfigJson: Uint8Array;
  dictionariesJson: Uint8Array | undefined;
  gazetteerJson: Uint8Array | undefined;
};

/**
 * Serialize the assembler inputs the Rust binding expects. Dictionaries are
 * stripped from the pipeline config and passed out of band: the assembler reads
 * the separate bundle preferentially, and keeping the (large) dictionaries out
 * of the config JSON avoids serializing them twice.
 */
const toAssembleInputs = (
  { dictionaries, enableNer = false, ...config }: PipelineConfig,
  gazetteerEntries: readonly GazetteerEntry[],
): AssembleInputs => ({
  pipelineConfigJson: encoder.encode(JSON.stringify({ ...config, enableNer })),
  dictionariesJson:
    dictionaries === undefined
      ? undefined
      : encoder.encode(JSON.stringify(dictionaries)),
  gazetteerJson:
    gazetteerEntries.length === 0
      ? undefined
      : encoder.encode(JSON.stringify(gazetteerEntries)),
});

const assemblePackageBytes = (
  binding: NativeAnonymizeBinding,
  { pipelineConfigJson, dictionariesJson, gazetteerJson }: AssembleInputs,
  compressed: boolean,
): Uint8Array => {
  const assemble = compressed
    ? binding.assembleStaticSearchCompressedPackageBytes
    : binding.assembleStaticSearchPackageBytes;
  if (assemble === undefined) {
    throw new Error(
      "Native anonymize binding does not support static-search config assembly",
    );
  }
  return assemble(pipelineConfigJson, dictionariesJson, gazetteerJson);
};

export const prepareNativePipelineConfig = async ({
  binding,
  config,
  gazetteerEntries = [],
}: Omit<
  NativePipelineBuildOptions,
  "context"
>): Promise<NativePreparedSearchConfig> => {
  const scopedConfig = applyPipelineLanguageScope(config);
  assertNativePipelineSupported(scopedConfig);
  const assemble = binding.assembleStaticSearchConfigJson;
  if (assemble === undefined) {
    throw new Error(
      "Native anonymize binding does not support static-search config assembly",
    );
  }
  const { pipelineConfigJson, dictionariesJson, gazetteerJson } =
    toAssembleInputs(scopedConfig, gazetteerEntries);
  const configJson = assemble(
    pipelineConfigJson,
    dictionariesJson,
    gazetteerJson,
  );
  return JSON.parse(new TextDecoder().decode(configJson));
};

export const prepareNativePipelinePackage = async ({
  binding,
  config,
  gazetteerEntries = [],
  context,
  compressed = false,
}: NativePipelinePackageOptions): Promise<Uint8Array> => {
  const packageBytes = await getCachedNativePipelinePackage({
    config,
    binding,
    gazetteerEntries,
    ...(context ? { context } : {}),
    compressed,
  });
  // Return a genuine copy: with the real NAPI binding packageBytes is a Node
  // Buffer, and Buffer.prototype.slice() yields a memory-sharing view, so a
  // caller mutating it would corrupt the shared cache and ctx.nativePipelinePackage.
  return new Uint8Array(packageBytes);
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
  compressed = false,
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
    touchSharedPackageCacheEntry(sharedCache, key, shared);
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
    compressed,
  });
  ctx.nativePipelinePackagePromise = promise;
  touchSharedPackageCacheEntry(sharedCache, key, promise);
  let packageBytes: Uint8Array;
  try {
    packageBytes = await promise;
  } catch (error) {
    if (sharedCache.get(key) === promise) {
      sharedCache.delete(key);
    }
    if (
      ctx.nativePipelinePackageKey === key &&
      ctx.nativePipelinePackagePromise === promise
    ) {
      ctx.nativePipelinePackage = null;
      ctx.nativePipelinePackagePromise = null;
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

// `async` so the shared package cache can store the in-flight value and dedupe
// concurrent builds for the same key, and so assembly failures (an older
// binding without the assemble functions, or a config the assembler rejects)
// surface as a rejected promise rather than a synchronous throw mid-cache-flow.
const buildNativePipelinePackage = async ({
  binding,
  config,
  gazetteerEntries,
  compressed,
}: Required<
  Omit<NativePipelinePackageOptions, "context">
>): Promise<Uint8Array> =>
  assemblePackageBytes(
    binding,
    toAssembleInputs(config, gazetteerEntries),
    compressed,
  );

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
    dictionaryCacheKey(config.dictionaries),
    pipelineConfigKey(config, gazetteerEntries),
  ].join(":");
