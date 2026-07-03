/**
 * Shared test helper: run text through the Rust-native anonymize SDK.
 *
 * The retargeted detection corpus used to build entities with the legacy
 * TypeScript pipeline (`createPipelineContext` + `runPipeline`). These helpers
 * expose the same "config in, resolved entities out" shape backed by the native
 * prepared pipeline so the recall/precision assertions can stay intact.
 *
 * The native binding is loaded once per test process. Prepared pipelines are
 * cached per config so a test file that reuses one config does not rebuild the
 * prepared package for every case (the underlying SDK also dedups the expensive
 * package build, but caching the wrapper avoids the per-call digest hash).
 */
import { createPipelineContext, type PipelineContext } from "../context";
import { loadNativeAnonymizeBinding } from "../native-node";
import type {
  NativeOperatorConfig,
  NativePipelineEntity,
  NativeStaticRedactionResult,
} from "../native";
import { createNativePipelineFromConfig } from "../native-pipeline";
import type { PreparedNativePipeline } from "../native";
import { pipelineConfigKey } from "../pipeline-cache-key";
import type { Dictionaries, GazetteerEntry, PipelineConfig } from "../types";

export type NativeDetectOptions = {
  gazetteerEntries?: GazetteerEntry[];
  context?: PipelineContext;
  operators?: NativeOperatorConfig;
};

let cachedBinding: ReturnType<typeof loadNativeAnonymizeBinding> | undefined;

const getBinding = (): ReturnType<typeof loadNativeAnonymizeBinding> => {
  if (cachedBinding === undefined) {
    cachedBinding = loadNativeAnonymizeBinding();
  }
  return cachedBinding;
};

const dictionaryCacheIds = new WeakMap<Dictionaries, number>();
let nextDictionaryCacheId = 0;

const dictionaryCacheKey = (
  dictionaries: Dictionaries | null | undefined,
): string => {
  // null is `typeof object` but not a valid WeakMap key, so guard it here
  // alongside undefined before touching the WeakMap.
  if (dictionaries === undefined || dictionaries === null) {
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

const pipelineCache = new Map<string, Promise<PreparedNativePipeline>>();

// One PipelineContext shared across every config in the test process. The
// context caches config-dependent bundle artifacts (name corpus, derived
// stopwords, prepared package), but those caches are config-keyed in the SDK,
// so reusing a single context across different configs is safe and mirrors how
// a production caller reuses a context. See context-cache-keying.test.ts, the
// regression that proves an earlier config no longer poisons a later one.
const sharedContext = createPipelineContext();

const getPipeline = (
  config: PipelineConfig,
  { gazetteerEntries = [], context }: NativeDetectOptions,
): Promise<PreparedNativePipeline> => {
  const binding = getBinding();
  const key = [
    dictionaryCacheKey(config.dictionaries),
    pipelineConfigKey(config, gazetteerEntries),
  ].join(":");
  const cached = pipelineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pipeline = createNativePipelineFromConfig({
    binding,
    config,
    gazetteerEntries,
    context: context ?? sharedContext,
  });
  pipelineCache.set(key, pipeline);
  return pipeline;
};

/**
 * Run `fullText` through the native pipeline built from `config` and return the
 * full static redaction result (resolved entities plus redacted text,
 * redaction map, operator map, and entity count).
 */
export const redactNative = async (
  config: PipelineConfig,
  fullText: string,
  options: NativeDetectOptions = {},
): Promise<NativeStaticRedactionResult> => {
  const pipeline = await getPipeline(config, options);
  return pipeline.redactText(fullText, options.operators);
};

/**
 * Run `fullText` through the native pipeline and return only the resolved
 * entities. Mirrors the legacy `runPipeline` return value the detection corpus
 * was written against (label, text, start, end, score, source).
 */
export const detectNative = async (
  config: PipelineConfig,
  fullText: string,
  options: NativeDetectOptions = {},
): Promise<NativePipelineEntity[]> => {
  const result = await redactNative(config, fullText, options);
  return result.resolvedEntities;
};
