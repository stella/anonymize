import type { Dictionaries, PipelineConfig } from "./types";
import type { NativeAnonymizeBinding, PreparedNativePipeline } from "./native";
import { defaultDictionaryBundleOptions } from "./build-native-package";
import { createNativePipelineFromConfig } from "./native-pipeline";
import { DEFAULT_NATIVE_PIPELINE_CONFIG } from "./native-default-config";
import { applyPipelineLanguageScope } from "./language-scope";
import {
  pipelineLanguageSelectionKey,
  type NormalizedPipelineLanguageSelection,
} from "./pipeline-language";

type ScopedPipelineLanguageSelection = Extract<
  NormalizedPipelineLanguageSelection,
  { type: "languages" }
>;

type CreateScopedPipelineOptions = {
  binding: NativeAnonymizeBinding;
  selection: ScopedPipelineLanguageSelection;
};

type AnonymizeDataModule = {
  loadDictionaryBundle: (options?: {
    countries?: readonly string[];
    cityCountries?: readonly string[];
    nameLanguages?: readonly string[];
  }) => Promise<Dictionaries>;
};

const dictionaryCache = new Map<string, Promise<Dictionaries>>();
const scopedPipelineCache = new WeakMap<
  NativeAnonymizeBinding,
  Map<string, Promise<PreparedNativePipeline>>
>();
const MAX_SCOPED_PIPELINE_CACHE_ENTRIES = 8;

const getCachedEntry = <Value>(
  cache: Map<string, Value>,
  key: string,
): Value | undefined => {
  const cached = cache.get(key);
  if (cached === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, cached);
  return cached;
};

const setCachedEntry = <Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
): void => {
  cache.set(key, value);
  if (cache.size <= MAX_SCOPED_PIPELINE_CACHE_ENTRIES) {
    return;
  }
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
};

const loadScopedDictionaries = (
  key: string,
  config: PipelineConfig,
): Promise<Dictionaries> => {
  const cached = getCachedEntry(dictionaryCache, key);
  if (cached !== undefined) {
    return cached;
  }
  // Keep dictionary chunks out of the default-package import path. Bundlers
  // load only the chunks needed to assemble an unbundled semantic scope.
  const dictionaries = import("@stll/anonymize-data/cities")
    .then(({ loadDictionaryBundle }: AnonymizeDataModule) =>
      loadDictionaryBundle(defaultDictionaryBundleOptions(config)),
    )
    .catch((error: unknown) => {
      dictionaryCache.delete(key);
      throw error;
    });
  setCachedEntry(dictionaryCache, key, dictionaries);
  return dictionaries;
};

const pipelineConfigFor = (
  selection: ScopedPipelineLanguageSelection,
): PipelineConfig => {
  const [language, ...languages] = selection.languages;
  return applyPipelineLanguageScope({
    ...DEFAULT_NATIVE_PIPELINE_CONFIG,
    labels: [...DEFAULT_NATIVE_PIPELINE_CONFIG.labels],
    workspaceId: `default-pipeline:${pipelineLanguageSelectionKey(selection)}`,
    ...(languages.length === 0
      ? { language }
      : { languages: [language, ...languages] }),
  });
};

const scopedPipelineCacheFor = (
  binding: NativeAnonymizeBinding,
): Map<string, Promise<PreparedNativePipeline>> => {
  const cached = scopedPipelineCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, Promise<PreparedNativePipeline>>();
  scopedPipelineCache.set(binding, created);
  return created;
};

export const createScopedPipeline = ({
  binding,
  selection,
}: CreateScopedPipelineOptions): Promise<PreparedNativePipeline> => {
  const key = pipelineLanguageSelectionKey(selection);
  const cache = scopedPipelineCacheFor(binding);
  const cached = getCachedEntry(cache, key);
  if (cached !== undefined) {
    return cached;
  }
  const config = pipelineConfigFor(selection);
  const pipeline = loadScopedDictionaries(key, config)
    .then((dictionaries) =>
      createNativePipelineFromConfig({
        binding,
        config: { ...config, dictionaries },
      }),
    )
    .catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
  setCachedEntry(cache, key, pipeline);
  return pipeline;
};
