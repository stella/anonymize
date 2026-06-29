import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  assertNativeBindingVersion,
  createNativePipelineFromPackage,
  type NativeOperatorConfig,
  type NativeAnonymizeBinding,
  type NativeNormalizeOptions,
  type NativeSearchPackageInput,
  PreparedNativeAnonymizer,
  PreparedNativePipeline,
  type NativeStaticRedactionResult,
  diagnostics_json as diagnosticsJsonWithBinding,
  load_prepared_package as loadPreparedPackageWithBinding,
  native_package_version as nativePackageVersionWithBinding,
  normalize_for_search as normalizeForSearchWithBinding,
  prepare_search_package as prepareSearchPackageWithBinding,
  redact_text as redactTextWithBinding,
  redact_text_json as redactTextJsonWithBinding,
  summary_diagnostics_json as summaryDiagnosticsJsonWithBinding,
} from "./native";

export * from "./native";

export type NativeRequire = (specifier: string) => unknown;

export type NativeLibc = "gnu" | "musl";

export type LoadNativeBindingOptions = {
  expectedVersion?: string;
  platform?: string;
  arch?: string;
  libc?: NativeLibc;
  env?: Record<string, string | undefined>;
  requireModule?: NativeRequire;
};

export type NativePipelinePackageFileOptions = LoadNativeBindingOptions & {
  binding?: NativeAnonymizeBinding;
  packagePath: string;
};

export type NativeSdkOptions = LoadNativeBindingOptions & {
  binding?: NativeAnonymizeBinding;
};

export type NativeSdkPackageOptions = NativeSdkOptions & {
  compressed?: boolean;
};

export type DefaultNativePipelinePackageOptions = LoadNativeBindingOptions & {
  binding?: NativeAnonymizeBinding;
  language?: string;
  packagePath?: string;
  warmup?: DefaultNativePipelineWarmup;
};

type ResolvedDefaultNativePipelineOptions = {
  binding: NativeAnonymizeBinding;
  language?: string;
  packagePath?: string;
  warmup: DefaultNativePipelineWarmup;
};

export const DEFAULT_NATIVE_PIPELINE_WARMUPS = {
  lazyRegex: "lazy-regex",
  none: "none",
} as const;

export type DefaultNativePipelineWarmup =
  (typeof DEFAULT_NATIVE_PIPELINE_WARMUPS)[keyof typeof DEFAULT_NATIVE_PIPELINE_WARMUPS];

export type DefaultNativePipelinePackageFileOptions = {
  language?: string;
};

const LOCAL_NATIVE_LOADER = "../index.cjs";
const PACKAGE_SPECIFIC_NATIVE_PATH = "STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH";
const DEFAULT_NATIVE_PIPELINE_PACKAGE_URL = new URL(
  "../native-pipeline.stlanonpkg",
  import.meta.url,
);
const DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DEFAULT_NATIVE_PIPELINE_PACKAGE_CACHE_KEY = "<default>";
const defaultNativePipelineCache = new WeakMap<
  NativeAnonymizeBinding,
  Map<string, PreparedNativePipeline>
>();
const warmedDefaultNativePipelines = new WeakSet<PreparedNativePipeline>();
const defaultNativePipelineInflightCache = new WeakMap<
  NativeAnonymizeBinding,
  Map<string, Promise<PreparedNativePipeline>>
>();

export { DEFAULT_NATIVE_PIPELINE_CONFIG } from "./native-default-config";

export const loadNativeAnonymizeBinding = (
  options: LoadNativeBindingOptions = {},
): NativeAnonymizeBinding => {
  const requireModule = options.requireModule ?? createRequire(import.meta.url);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const specifiers = nativeBindingSpecifiers({ env });
  const errors: string[] = [];

  for (const specifier of specifiers) {
    const binding = tryLoadNativeBinding({
      specifier,
      requireModule,
      errors,
    });
    if (!binding) {
      continue;
    }
    if (options.expectedVersion !== undefined) {
      assertNativeBindingVersion({
        binding,
        expectedVersion: options.expectedVersion,
      });
    }
    return binding;
  }

  throw new Error(
    `Unable to load native anonymize binding for ${platform}/${arch}:\n${errors.join("\n")}`,
  );
};

export const readNativePipelinePackageFile = (
  packagePath: string,
): Uint8Array => readFileSync(packagePath);

export const readNativePipelinePackageFileAsync = async (
  packagePath: string,
): Promise<Uint8Array> => readFile(packagePath);

export const native_package_version = (
  options: NativeSdkOptions = {},
): string => nativePackageVersionWithBinding(resolveNativeSdkBinding(options));

export const normalize_for_search = (
  text: string,
  options: NativeSdkOptions = {},
): string => {
  const args: NativeNormalizeOptions = {
    binding: resolveNativeSdkBinding(options),
    text,
  };
  return normalizeForSearchWithBinding(args);
};

export const prepare_search_package = (
  config: NativeSearchPackageInput,
  { compressed = true, ...options }: NativeSdkPackageOptions = {},
): Uint8Array =>
  prepareSearchPackageWithBinding({
    binding: resolveNativeSdkBinding(options),
    config,
    compressed,
  });

export const load_prepared_package = (
  packageBytes: Uint8Array,
  options: NativeSdkOptions = {},
) =>
  loadPreparedPackageWithBinding({
    binding: resolveNativeSdkBinding(options),
    packageBytes,
  });

export const load_prepared_package_file = (
  packagePath: string,
  options: NativeSdkOptions = {},
) => load_prepared_package(readNativePipelinePackageFile(packagePath), options);

export const redact_text = (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options: NativeSdkOptions = {},
): NativeStaticRedactionResult =>
  redactTextWithBinding({
    binding: resolveNativeSdkBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const redact_text_json = (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options: NativeSdkOptions = {},
): string =>
  redactTextJsonWithBinding({
    binding: resolveNativeSdkBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const diagnostics_json = (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options: NativeSdkOptions = {},
): string | null =>
  diagnosticsJsonWithBinding({
    binding: resolveNativeSdkBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const summary_diagnostics_json = (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options: NativeSdkOptions = {},
): string | null =>
  summaryDiagnosticsJsonWithBinding({
    binding: resolveNativeSdkBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const readDefaultNativePipelinePackageFile = ({
  language,
}: DefaultNativePipelinePackageFileOptions = {}): Uint8Array => {
  const packageUrl = defaultNativePipelinePackageUrl(language);
  try {
    return readFileSync(packageUrl);
  } catch (error) {
    throw new Error(
      `${defaultNativePipelinePackageDescription(language)} is unavailable: ${formatLoadError(error)}`,
    );
  }
};

export const read_default_native_pipeline_package_file = (
  options: DefaultNativePipelinePackageFileOptions = {},
): Uint8Array => readDefaultNativePipelinePackageFile(options);

export const readDefaultNativePipelinePackageFileAsync = async ({
  language,
}: DefaultNativePipelinePackageFileOptions = {}): Promise<Uint8Array> => {
  const packageUrl = defaultNativePipelinePackageUrl(language);
  try {
    return await readFile(packageUrl);
  } catch (error) {
    throw new Error(
      `${defaultNativePipelinePackageDescription(language)} is unavailable: ${formatLoadError(error)}`,
    );
  }
};

export const createNativePipelineFromPackageFile = ({
  binding,
  packagePath,
  expectedVersion,
  ...loadOptions
}: NativePipelinePackageFileOptions): PreparedNativePipeline => {
  const resolvedBinding =
    binding ??
    loadNativeAnonymizeBinding({
      ...loadOptions,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  if (binding && expectedVersion !== undefined) {
    assertNativeBindingVersion({ binding, expectedVersion });
  }
  return createNativePipelineFromPackage({
    binding: resolvedBinding,
    packageBytes: readNativePipelinePackageFile(packagePath),
  });
};

export const createNativePipelineFromDefaultPackage = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => {
  const resolvedOptions = resolveDefaultNativePipelineOptions(options);
  return applyDefaultNativePipelineWarmup(
    createNativePipelineFromResolvedDefaultPackage(resolvedOptions),
    resolvedOptions.warmup,
  );
};

export const create_native_pipeline_from_default_package = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => createNativePipelineFromDefaultPackage(options);

export const getDefaultNativePipeline = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => {
  const resolvedOptions = resolveDefaultNativePipelineOptions(options);
  const cache = defaultPipelineCacheFor(resolvedOptions.binding);
  const key = defaultPipelineCacheKey(resolvedOptions);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return applyDefaultNativePipelineWarmup(cached, resolvedOptions.warmup);
  }
  const pipeline =
    createNativePipelineFromResolvedDefaultPackage(resolvedOptions);
  cache.set(key, pipeline);
  return applyDefaultNativePipelineWarmup(pipeline, resolvedOptions.warmup);
};

export const get_default_native_pipeline = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => getDefaultNativePipeline(options);

export const preloadDefaultNativePipeline = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => {
  const pipeline = getDefaultNativePipeline(options);
  return applyDefaultNativePipelineWarmup(
    pipeline,
    DEFAULT_NATIVE_PIPELINE_WARMUPS.lazyRegex,
  );
};

export const preload_default_native_pipeline = (
  options: DefaultNativePipelinePackageOptions = {},
): PreparedNativePipeline => preloadDefaultNativePipeline(options);

export const redactDefaultText = (
  fullText: string,
  operators?: NativeOperatorConfig,
  options: DefaultNativePipelinePackageOptions = {},
): NativeStaticRedactionResult =>
  getDefaultNativePipeline(options).redactText(fullText, operators);

export const redact_default_text = (
  fullText: string,
  operators?: NativeOperatorConfig,
  options: DefaultNativePipelinePackageOptions = {},
): NativeStaticRedactionResult =>
  redactDefaultText(fullText, operators, options);

export const redactDefaultTextJson = (
  fullText: string,
  operators?: NativeOperatorConfig,
  options: DefaultNativePipelinePackageOptions = {},
): string =>
  getDefaultNativePipeline(options).redact_text_json(fullText, operators);

export const redact_default_text_json = (
  fullText: string,
  operators?: NativeOperatorConfig,
  options: DefaultNativePipelinePackageOptions = {},
): string => redactDefaultTextJson(fullText, operators, options);

export const preloadDefaultNativePipelineAsync = (
  options: DefaultNativePipelinePackageOptions = {},
): Promise<PreparedNativePipeline> => {
  const resolvedOptions = {
    ...resolveDefaultNativePipelineOptions(options),
    warmup: DEFAULT_NATIVE_PIPELINE_WARMUPS.lazyRegex,
  };
  const cache = defaultPipelineCacheFor(resolvedOptions.binding);
  const key = defaultPipelineCacheKey(resolvedOptions);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(
      applyDefaultNativePipelineWarmup(cached, resolvedOptions.warmup),
    );
  }

  const inflightCache = defaultPipelineInflightCacheFor(
    resolvedOptions.binding,
  );
  const inflight = inflightCache.get(key);
  if (inflight !== undefined) {
    return inflight;
  }

  const promise = createNativePipelineFromResolvedDefaultPackageAsync(
    resolvedOptions,
  )
    .then((pipeline) => {
      cache.set(key, pipeline);
      return applyDefaultNativePipelineWarmup(pipeline, resolvedOptions.warmup);
    })
    .finally(() => {
      inflightCache.delete(key);
    });
  inflightCache.set(key, promise);
  return promise;
};

const resolveDefaultNativePipelineOptions = ({
  binding,
  language,
  packagePath,
  warmup,
  expectedVersion,
  ...loadOptions
}: DefaultNativePipelinePackageOptions = {}): ResolvedDefaultNativePipelineOptions => {
  if (language !== undefined && packagePath !== undefined) {
    throw new Error("Use either language or packagePath, not both");
  }
  const resolvedBinding =
    binding ??
    loadNativeAnonymizeBinding({
      ...loadOptions,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  if (binding && expectedVersion !== undefined) {
    assertNativeBindingVersion({ binding, expectedVersion });
  }
  return {
    binding: resolvedBinding,
    warmup: normalizeDefaultNativePipelineWarmup(warmup),
    ...(language !== undefined
      ? { language: normalizeDefaultNativePipelineLanguage(language) }
      : {}),
    ...(packagePath !== undefined ? { packagePath } : {}),
  };
};

const applyDefaultNativePipelineWarmup = (
  pipeline: PreparedNativePipeline,
  warmup: DefaultNativePipelineWarmup,
): PreparedNativePipeline => {
  if (warmup !== DEFAULT_NATIVE_PIPELINE_WARMUPS.lazyRegex) {
    return pipeline;
  }
  if (!warmedDefaultNativePipelines.has(pipeline)) {
    pipeline.warmLazyRegex();
    warmedDefaultNativePipelines.add(pipeline);
  }
  return pipeline;
};

const createNativePipelineFromResolvedDefaultPackage = ({
  binding,
  language,
  packagePath,
}: ResolvedDefaultNativePipelineOptions): PreparedNativePipeline => {
  const packageBytes =
    packagePath === undefined
      ? readDefaultNativePipelinePackageFile(
          defaultPackageFileOptions(language),
        )
      : readNativePipelinePackageFile(packagePath);
  return createNativePipelineFromTrustedDefaultPackage(binding, packageBytes);
};

const createNativePipelineFromResolvedDefaultPackageAsync = async ({
  binding,
  language,
  packagePath,
}: ResolvedDefaultNativePipelineOptions): Promise<PreparedNativePipeline> => {
  const packageBytes =
    packagePath === undefined
      ? await readDefaultNativePipelinePackageFileAsync(
          defaultPackageFileOptions(language),
        )
      : await readNativePipelinePackageFileAsync(packagePath);
  return createNativePipelineFromTrustedDefaultPackage(binding, packageBytes);
};

const createNativePipelineFromTrustedDefaultPackage = (
  binding: NativeAnonymizeBinding,
  packageBytes: Uint8Array,
): PreparedNativePipeline =>
  new PreparedNativePipeline(
    new PreparedNativeAnonymizer(
      binding.NativePreparedSearch.fromTrustedPreparedPackageBytes?.(
        packageBytes,
      ) ??
        binding.NativePreparedSearch.fromPreparedPackageBytesWithoutCache?.(
          packageBytes,
        ) ??
        binding.NativePreparedSearch.fromPreparedPackageBytes(packageBytes),
    ),
  );

const defaultPackageFileOptions = (
  language: string | undefined,
): DefaultNativePipelinePackageFileOptions =>
  language === undefined ? {} : { language };

const normalizeDefaultNativePipelineWarmup = (
  warmup: DefaultNativePipelineWarmup | undefined,
): DefaultNativePipelineWarmup => {
  if (warmup === undefined) {
    return DEFAULT_NATIVE_PIPELINE_WARMUPS.none;
  }
  switch (warmup) {
    case DEFAULT_NATIVE_PIPELINE_WARMUPS.lazyRegex:
    case DEFAULT_NATIVE_PIPELINE_WARMUPS.none:
      return warmup;
  }
  throw new Error(
    'Default native pipeline warmup must be "lazy-regex" or "none"',
  );
};

const resolveNativeSdkBinding = ({
  binding,
  expectedVersion,
  ...loadOptions
}: NativeSdkOptions): NativeAnonymizeBinding => {
  const resolvedBinding =
    binding ??
    loadNativeAnonymizeBinding({
      ...loadOptions,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  if (binding && expectedVersion !== undefined) {
    assertNativeBindingVersion({ binding, expectedVersion });
  }
  return resolvedBinding;
};

const defaultPipelineCacheFor = (
  binding: NativeAnonymizeBinding,
): Map<string, PreparedNativePipeline> => {
  const cached = defaultNativePipelineCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, PreparedNativePipeline>();
  defaultNativePipelineCache.set(binding, created);
  return created;
};

const defaultPipelineInflightCacheFor = (
  binding: NativeAnonymizeBinding,
): Map<string, Promise<PreparedNativePipeline>> => {
  const cached = defaultNativePipelineInflightCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, Promise<PreparedNativePipeline>>();
  defaultNativePipelineInflightCache.set(binding, created);
  return created;
};

const defaultPipelineCacheKey = ({
  binding,
  language,
  packagePath,
}: ResolvedDefaultNativePipelineOptions): string =>
  [
    binding.nativePackageVersion(),
    packagePath ??
      (language === undefined
        ? DEFAULT_NATIVE_PIPELINE_PACKAGE_CACHE_KEY
        : `language:${language}`),
  ].join("\0");

const defaultNativePipelinePackageUrl = (language: string | undefined): URL => {
  if (language === undefined) {
    return DEFAULT_NATIVE_PIPELINE_PACKAGE_URL;
  }
  const normalized = normalizeDefaultNativePipelineLanguage(language);
  return new URL(
    `../native-pipeline.${normalized}.stlanonpkg`,
    import.meta.url,
  );
};

const defaultNativePipelinePackageDescription = (
  language: string | undefined,
): string =>
  language === undefined
    ? "Default native pipeline package"
    : `Default native pipeline package for language "${normalizeDefaultNativePipelineLanguage(language)}"`;

const normalizeDefaultNativePipelineLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (!DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.test(normalized)) {
    throw new Error(
      `Default native pipeline language must match ${DEFAULT_NATIVE_PIPELINE_LANGUAGE_PATTERN.source}`,
    );
  }
  return normalized;
};

type NativeBindingSpecifiersOptions = {
  env: Record<string, string | undefined>;
};

const nativeBindingSpecifiers = ({
  env,
}: NativeBindingSpecifiersOptions): string[] => {
  const specifiers: string[] = [];
  const overridePath = env[PACKAGE_SPECIFIC_NATIVE_PATH];
  if (overridePath) {
    specifiers.push(overridePath);
  }
  specifiers.push(LOCAL_NATIVE_LOADER);
  return specifiers;
};

type TryLoadNativeBindingOptions = {
  specifier: string;
  requireModule: NativeRequire;
  errors: string[];
};

const tryLoadNativeBinding = ({
  specifier,
  requireModule,
  errors,
}: TryLoadNativeBindingOptions): NativeAnonymizeBinding | null => {
  try {
    const loaded = requireModule(specifier);
    const binding = toNativeAnonymizeBinding(loaded);
    if (binding) {
      return binding;
    }
    errors.push(`${specifier}: module does not match native binding shape`);
  } catch (error) {
    errors.push(`${specifier}: ${formatLoadError(error)}`);
  }
  return null;
};

const toNativeAnonymizeBinding = (
  value: unknown,
): NativeAnonymizeBinding | null => {
  const candidate =
    isPropertyBag(value) && isPropertyBag(value["default"])
      ? value["default"]
      : value;
  return isNativeAnonymizeBinding(candidate) ? candidate : null;
};

const isNativeAnonymizeBinding = (
  candidate: unknown,
): candidate is NativeAnonymizeBinding => {
  if (!isPropertyBag(candidate)) {
    return false;
  }
  if (typeof candidate["nativePackageVersion"] !== "function") {
    return false;
  }
  if (typeof candidate["normalizeForSearch"] !== "function") {
    return false;
  }
  if (typeof candidate["prepareStaticSearchPackageBytes"] !== "function") {
    return false;
  }
  if (
    typeof candidate["prepareStaticSearchCompressedPackageBytes"] !== "function"
  ) {
    return false;
  }
  const preparedSearch = candidate["NativePreparedSearch"];
  if (!isPropertyBag(preparedSearch)) {
    return false;
  }
  if (typeof preparedSearch["fromConfigJsonBytes"] !== "function") {
    return false;
  }
  if (typeof preparedSearch["fromPreparedPackageBytes"] !== "function") {
    return false;
  }
  return true;
};

const isPropertyBag = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const formatLoadError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
