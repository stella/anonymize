/* @stll/anonymize-wasm — browser / WebAssembly entry.
 *
 * Exposes the same native-SDK surface as `@stll/anonymize/native` (the
 * runtime-agnostic layer in `native.ts`), backed by the napi-rs
 * wasm32-wasip1-threads binding instead of the `.node` sidecars. The old
 * TS-pipeline surface (`runPipeline` and friends) is intentionally gone here:
 * this package now redacts entirely through the wasm binding and PREBUILT
 * prepared packages.
 *
 * Browsers load prepared packages only (no in-browser config building): pass
 * package bytes, an `ArrayBuffer`, or a URL to fetch, or call
 * `loadDefaultPipeline()` for the default package bundled in the tarball.
 *
 * No module-level side effects: the wasm binding is instantiated lazily on
 * first use via `getBinding()`. The napi-generated glue is loaded from the
 * package's own `native/` asset directory — `index.wasi.cjs` under Node's WASI
 * runtime, `index.wasi-browser.js` (fetch + Worker) in browsers.
 */

import {
  createNativeAnonymizerFromPackage,
  createNativePipelineFromPackage,
  diagnostics_json as diagnosticsJsonWithBinding,
  diagnostics_stream_json as diagnosticsStreamJsonWithBinding,
  type NativeAnonymizeBinding,
  type NativeDiagnosticsBatchCallback,
  type NativeOperatorConfig,
  type NativeResultEventCallback,
  type NativeSearchPackageInput,
  type NativeStaticRedactionResult,
  native_package_version as nativePackageVersionWithBinding,
  normalize_for_search as normalizeForSearchWithBinding,
  PreparedNativeAnonymizer,
  PreparedNativePipeline,
  prepare_search_package as prepareSearchPackageWithBinding,
  redact_text as redactTextWithBinding,
  redact_text_json as redactTextJsonWithBinding,
  redact_text_stream_json as redactTextStreamJsonWithBinding,
  summary_diagnostics_json as summaryDiagnosticsJsonWithBinding,
} from "./native";

export * from "./native";
export { deanonymise, exportRedactionKey } from "./redact";
export {
  DEFAULT_ENTITY_LABELS,
  DETECTION_SOURCES,
  DETECTOR_PRIORITY,
  OPERATOR_TYPES,
} from "./types";
export type {
  AnonymisationOperator,
  DetectionSource,
  Entity,
  OperatorConfig,
  OperatorType,
  RedactionResult,
  ReviewDecision,
  ReviewedEntity,
} from "./types";

/** A prepared package the caller supplies: raw bytes, an ArrayBuffer, or a URL
 * (string or `URL`) that resolves to the package and is fetched. */
export type PreparedPackageSource = Uint8Array | ArrayBuffer | URL | string;

/** Escape hatch for callers that already hold a binding (e.g. a custom sidecar
 * or a test double). When omitted, the lazily-instantiated wasm binding is
 * used. */
export type WasmBindingOptions = {
  binding?: NativeAnonymizeBinding;
};

const NODE_GLUE_MODULE = "index.wasi.cjs";
const BROWSER_GLUE_MODULE = "index.wasi-browser.js";
const NATIVE_ASSET_DIR = "native";
const DEFAULT_PACKAGE_FILE = "native-pipeline.stlanonpkg";
const LANGUAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

let bindingPromise: Promise<NativeAnonymizeBinding> | undefined;
const defaultPipelineCache = new Map<string, Promise<PreparedNativePipeline>>();

/** Instantiate (once) and return the wasm binding. Safe to call repeatedly:
 * the underlying wasm module is instantiated a single time and cached. */
export const getBinding = (): Promise<NativeAnonymizeBinding> => {
  bindingPromise ??= loadWasmBinding();
  return bindingPromise;
};

const loadWasmBinding = async (): Promise<NativeAnonymizeBinding> => {
  const glueModule = isNodeRuntime() ? NODE_GLUE_MODULE : BROWSER_GLUE_MODULE;
  const glueUrl = assetUrl(glueModule);
  // The specifier is deliberately a runtime asset URL (resolved against the
  // package's own `native/` directory), not a module the bundler should follow:
  // the napi-rs glue lives outside src and is copied in at build time.
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const loaded: unknown = await import(/* @vite-ignore */ glueUrl.href);
  return toNativeAnonymizeBinding(loaded);
};

type RuntimeGlobals = {
  process?: { versions?: { node?: string } };
  window?: unknown;
};

const isNodeRuntime = (): boolean => {
  const globals: RuntimeGlobals = globalThis;
  return (
    globals.window === undefined &&
    typeof globals.process?.versions?.node === "string"
  );
};

const assetUrl = (fileName: string): URL =>
  new URL(`./${NATIVE_ASSET_DIR}/${fileName}`, import.meta.url);

const resolveBinding = (
  options?: WasmBindingOptions,
): Promise<NativeAnonymizeBinding> =>
  options?.binding ? Promise.resolve(options.binding) : getBinding();

const toPackageBytes = async (
  source: PreparedPackageSource,
): Promise<Uint8Array> => {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  const response = await fetch(source instanceof URL ? source.href : source);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch prepared package (${response.status} ${response.statusText})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

// --- Prepared-package loaders (the primary browser flow) ---------------------

export type LoadPreparedPackageOptions = WasmBindingOptions;

/** Load a prepared package and return a pipeline ready to redact text. */
export const loadPipeline = async (
  source: PreparedPackageSource,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> => {
  const [binding, packageBytes] = await Promise.all([
    resolveBinding(options),
    toPackageBytes(source),
  ]);
  return createNativePipelineFromPackage({ binding, packageBytes });
};

/** Load a prepared package and return the lower-level anonymizer. */
export const load_prepared_package = async (
  source: PreparedPackageSource,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativeAnonymizer> => {
  const [binding, packageBytes] = await Promise.all([
    resolveBinding(options),
    toPackageBytes(source),
  ]);
  return createNativeAnonymizerFromPackage({ binding, packageBytes });
};

// --- Default package bundled in the tarball ----------------------------------

/** URL of a bundled default prepared package, resolved against this module so
 * it points at the `native/` asset directory shipped in the tarball. */
export const defaultPackageUrl = (language?: string): URL =>
  language === undefined
    ? assetUrl(DEFAULT_PACKAGE_FILE)
    : assetUrl(`native-pipeline.${normalizeLanguage(language)}.stlanonpkg`);

/** Load a fresh pipeline from the bundled default prepared package. */
export const loadDefaultPipeline = (
  language?: string,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> =>
  loadPipeline(defaultPackageUrl(language), options);

/** Cached variant of {@link loadDefaultPipeline}: the default pipeline for a
 * given language is fetched and prepared once, then reused. */
export const getDefaultPipeline = (
  language?: string,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> => {
  const key = language ?? "<default>";
  const cached = defaultPipelineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pipeline = loadDefaultPipeline(language, options);
  defaultPipelineCache.set(key, pipeline);
  return pipeline;
};

export const redactDefaultText = async (
  fullText: string,
  operators?: NativeOperatorConfig,
  language?: string,
): Promise<NativeStaticRedactionResult> =>
  (await getDefaultPipeline(language)).redactText(fullText, operators);

export const redactDefaultTextJson = async (
  fullText: string,
  operators?: NativeOperatorConfig,
  language?: string,
): Promise<string> =>
  (await getDefaultPipeline(language)).redact_text_json(fullText, operators);

// --- Binding-injected SDK surface (async parity with native-node) ------------

export const native_package_version = async (
  options?: WasmBindingOptions,
): Promise<string> =>
  nativePackageVersionWithBinding(await resolveBinding(options));

export const normalize_for_search = async (
  text: string,
  options?: WasmBindingOptions,
): Promise<string> =>
  normalizeForSearchWithBinding({
    binding: await resolveBinding(options),
    text,
  });

export type PrepareSearchPackageOptions = WasmBindingOptions & {
  compressed?: boolean;
};

export const prepare_search_package = async (
  config: NativeSearchPackageInput,
  { compressed = false, ...options }: PrepareSearchPackageOptions = {},
): Promise<Uint8Array> =>
  prepareSearchPackageWithBinding({
    binding: await resolveBinding(options),
    config,
    compressed,
  });

export const redact_text = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<NativeStaticRedactionResult> =>
  redactTextWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const redact_text_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  redactTextJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const redact_text_stream_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  onEvent: NativeResultEventCallback,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string | null> =>
  redactTextStreamJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    onEvent,
    ...(operators !== undefined ? { operators } : {}),
  });

export const diagnostics_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string | null> =>
  diagnosticsJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const diagnostics_stream_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  onBatch: NativeDiagnosticsBatchCallback,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string | null> =>
  diagnosticsStreamJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    onBatch,
    ...(operators !== undefined ? { operators } : {}),
  });

export const summary_diagnostics_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string | null> =>
  summaryDiagnosticsJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

// --- Binding extraction ------------------------------------------------------

const toNativeAnonymizeBinding = (loaded: unknown): NativeAnonymizeBinding => {
  const candidate = pickBindingCandidate(loaded);
  if (!isNativeAnonymizeBinding(candidate)) {
    throw new Error(
      "wasm binding module does not expose the native anonymize surface",
    );
  }
  return candidate;
};

const pickBindingCandidate = (loaded: unknown): unknown => {
  if (isRecord(loaded) && isNativeAnonymizeBinding(loaded["default"])) {
    return loaded["default"];
  }
  return loaded;
};

const isNativeAnonymizeBinding = (
  value: unknown,
): value is NativeAnonymizeBinding => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["nativePackageVersion"] !== "function") {
    return false;
  }
  if (typeof value["normalizeForSearch"] !== "function") {
    return false;
  }
  if (typeof value["prepareStaticSearchPackageBytes"] !== "function") {
    return false;
  }
  if (
    typeof value["prepareStaticSearchCompressedPackageBytes"] !== "function"
  ) {
    return false;
  }
  const preparedSearch = value["NativePreparedSearch"];
  if (!isRecord(preparedSearch)) {
    return false;
  }
  if (typeof preparedSearch["fromConfigJsonBytes"] !== "function") {
    return false;
  }
  return typeof preparedSearch["fromPreparedPackageBytes"] === "function";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const normalizeLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    throw new Error(`Language must match ${LANGUAGE_PATTERN.source}`);
  }
  return normalized;
};
