import type { NativePreparedSearchConfig } from "./build-unified-search";
import type { OperatorType } from "./types";

type NativeBindingOperatorConfig = {
  operators?: Record<string, OperatorType>;
  redactString?: string;
};

type NativeBindingRedactionEntry = {
  placeholder: string;
  original: string;
};

type NativeBindingOperatorEntry = {
  placeholder: string;
  operator: OperatorType;
};

type NativeBindingPipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  sourceDetail?: string | null;
};

type NativeBindingRedactionResult = {
  redactedText: string;
  redactionMap: NativeBindingRedactionEntry[];
  operatorMap: NativeBindingOperatorEntry[];
  entityCount: number;
};

type NativeBindingStaticRedactionResult = {
  resolvedEntities: NativeBindingPipelineEntity[];
  redaction: NativeBindingRedactionResult;
};

type CanonicalPipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  source_detail?: string | null;
};

type CanonicalStaticRedactionResult = {
  resolved_entities: CanonicalPipelineEntity[];
  redaction: {
    redacted_text: string;
    redaction_map: NativeBindingRedactionEntry[];
    operator_map: NativeBindingOperatorEntry[];
    entity_count: number;
  };
};

export type NativePreparedSearchBinding = {
  prepareDiagnosticsJson?: () => string;
  warmLazyRegex?: () => void;
  warm_lazy_regex?: () => void;
  warmLazyRegexDiagnosticsJson?: () => string;
  warm_lazy_regex_diagnostics_json?: () => string;
  redactStaticEntities: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => NativeBindingStaticRedactionResult;
  redactStaticEntitiesJson?: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesDiagnosticsJson?: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
};

export type NativeAnonymizeBinding = {
  normalizeForSearch: (text: string) => string;
  nativePackageVersion: () => string;
  NativePreparedSearch: {
    fromConfigJsonBytes: (
      configJson: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromPreparedPackageBytes: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
  };
  prepareStaticSearchPackageBytes: (configJson: Uint8Array) => Uint8Array;
  prepareStaticSearchCompressedPackageBytes: (
    configJson: Uint8Array,
  ) => Uint8Array;
};

export type NativeOperatorConfig = {
  operators?: Record<string, OperatorType>;
  redactString?: string;
};

export type NativePipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  sourceDetail?: string;
};

export type NativeRedactionResult = {
  redactedText: string;
  redactionMap: Map<string, string>;
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

export type NativeStaticRedactionResult = {
  resolvedEntities: NativePipelineEntity[];
  redaction: NativeRedactionResult;
};

export type NativeSearchPackageOptions = {
  binding: NativeAnonymizeBinding;
  config: NativePreparedSearchConfig;
  compressed?: boolean;
};

export type NativeSearchPackageInput =
  | NativePreparedSearchConfig
  | string
  | Uint8Array;

export type SharedNativeSearchPackageOptions = {
  binding: NativeAnonymizeBinding;
  config: NativeSearchPackageInput;
  compressed?: boolean;
};

export type SharedNativePreparedPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

export type SharedNativeRedactTextJsonOptions = {
  binding: NativeAnonymizeBinding;
  config: NativeSearchPackageInput;
  fullText: string;
  operators?: NativeOperatorConfig;
};

export type SharedNativeRedactTextOptions = SharedNativeRedactTextJsonOptions;

export type SharedNativeDiagnosticsJsonOptions =
  SharedNativeRedactTextJsonOptions;

export type NativeNormalizeOptions = {
  binding: NativeAnonymizeBinding;
  text: string;
};

export type NativeAnonymizerFromConfigOptions = {
  binding: NativeAnonymizeBinding;
  config: NativePreparedSearchConfig;
};

export type NativeAnonymizerFromPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

export type NativePipelineFromPackageOptions =
  NativeAnonymizerFromPackageOptions;

export type NativeBindingVersionOptions = {
  binding: NativeAnonymizeBinding;
  expectedVersion: string;
};

export class PreparedNativeAnonymizer {
  readonly #prepared: NativePreparedSearchBinding;

  constructor(prepared: NativePreparedSearchBinding) {
    this.#prepared = prepared;
  }

  prepareDiagnosticsJson(): string | null {
    return this.#prepared.prepareDiagnosticsJson?.() ?? null;
  }

  prepare_diagnostics_json(): string | null {
    return this.prepareDiagnosticsJson();
  }

  warmLazyRegex(): void {
    if (this.#prepared.warmLazyRegex) {
      this.#prepared.warmLazyRegex();
      return;
    }
    this.#prepared.warm_lazy_regex?.();
  }

  warm_lazy_regex(): void {
    this.warmLazyRegex();
  }

  warmLazyRegexDiagnosticsJson(): string | null {
    if (this.#prepared.warmLazyRegexDiagnosticsJson) {
      return this.#prepared.warmLazyRegexDiagnosticsJson();
    }
    return this.#prepared.warm_lazy_regex_diagnostics_json?.() ?? null;
  }

  warm_lazy_regex_diagnostics_json(): string | null {
    return this.warmLazyRegexDiagnosticsJson();
  }

  redactStaticEntities(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return toNativeStaticRedactionResult(
      this.#prepared.redactStaticEntities(
        fullText,
        toBindingOperatorConfig(operators),
      ),
    );
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntities(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    const bindingOperators = toBindingOperatorConfig(operators);
    if (this.#prepared.redactStaticEntitiesJson) {
      return this.#prepared.redactStaticEntitiesJson(
        fullText,
        bindingOperators,
      );
    }
    return JSON.stringify(
      toBindingStaticRedactionResult(
        toNativeStaticRedactionResult(
          this.#prepared.redactStaticEntities(fullText, bindingOperators),
        ),
      ),
    );
  }

  redactStaticEntitiesDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    if (!this.#prepared.redactStaticEntitiesDiagnosticsJson) {
      return null;
    }
    return this.#prepared.redactStaticEntitiesDiagnosticsJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactStaticEntitiesDiagnosticsJson(fullText, operators);
  }
}

export class PreparedNativePipeline {
  readonly #anonymizer: PreparedNativeAnonymizer;

  constructor(anonymizer: PreparedNativeAnonymizer) {
    this.#anonymizer = anonymizer;
  }

  prepareDiagnosticsJson(): string | null {
    return this.#anonymizer.prepareDiagnosticsJson();
  }

  prepare_diagnostics_json(): string | null {
    return this.prepareDiagnosticsJson();
  }

  warmLazyRegex(): void {
    this.#anonymizer.warmLazyRegex();
  }

  warm_lazy_regex(): void {
    this.warmLazyRegex();
  }

  warmLazyRegexDiagnosticsJson(): string | null {
    return this.#anonymizer.warmLazyRegexDiagnosticsJson();
  }

  warm_lazy_regex_diagnostics_json(): string | null {
    return this.warmLazyRegexDiagnosticsJson();
  }

  redactText(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.#anonymizer.redactStaticEntities(fullText, operators);
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactText(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    return JSON.stringify(
      toBindingStaticRedactionResult(this.redactText(fullText, operators)),
    );
  }

  redactTextDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.#anonymizer.redactStaticEntitiesDiagnosticsJson(
      fullText,
      operators,
    );
  }

  diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactTextDiagnosticsJson(fullText, operators);
  }
}

export const encodeNativeSearchConfig = (
  config: NativePreparedSearchConfig,
): Uint8Array => new TextEncoder().encode(JSON.stringify(config));

export const encodeNativeSearchConfigInput = (
  config: NativeSearchPackageInput,
): Uint8Array => {
  if (typeof config === "string") {
    return new TextEncoder().encode(config);
  }
  if (config instanceof Uint8Array) {
    return config;
  }
  return encodeNativeSearchConfig(config);
};

export const getNativeBindingVersion = (
  binding: NativeAnonymizeBinding,
): string => binding.nativePackageVersion();

export const native_package_version = getNativeBindingVersion;

export const normalize_for_search = ({
  binding,
  text,
}: NativeNormalizeOptions): string => binding.normalizeForSearch(text);

export const assertNativeBindingVersion = ({
  binding,
  expectedVersion,
}: NativeBindingVersionOptions): void => {
  const actualVersion = getNativeBindingVersion(binding);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Native anonymize binding version ${actualVersion} does not match ${expectedVersion}`,
    );
  }
};

export const prepareNativeSearchPackage = ({
  binding,
  config,
  compressed = true,
}: NativeSearchPackageOptions): Uint8Array => {
  const configBytes = encodeNativeSearchConfig(config);
  return compressed
    ? binding.prepareStaticSearchCompressedPackageBytes(configBytes)
    : binding.prepareStaticSearchPackageBytes(configBytes);
};

export const prepare_search_package = ({
  binding,
  config,
  compressed = true,
}: SharedNativeSearchPackageOptions): Uint8Array => {
  const configBytes = encodeNativeSearchConfigInput(config);
  return compressed
    ? binding.prepareStaticSearchCompressedPackageBytes(configBytes)
    : binding.prepareStaticSearchPackageBytes(configBytes);
};

export const createNativeAnonymizerFromConfig = ({
  binding,
  config,
}: NativeAnonymizerFromConfigOptions): PreparedNativeAnonymizer =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfig(config),
    ),
  );

export const createNativeAnonymizerFromPackage = ({
  binding,
  packageBytes,
}: NativeAnonymizerFromPackageOptions): PreparedNativeAnonymizer =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromPreparedPackageBytes(packageBytes),
  );

export const load_prepared_package = ({
  binding,
  packageBytes,
}: SharedNativePreparedPackageOptions): PreparedNativeAnonymizer =>
  createNativeAnonymizerFromPackage({ binding, packageBytes });

export const redact_text_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeRedactTextJsonOptions): string =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text_json(fullText, operators);

export const redact_text = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeRedactTextOptions): NativeStaticRedactionResult =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text(fullText, operators);

export const diagnostics_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeDiagnosticsJsonOptions): string | null =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).diagnostics_json(fullText, operators);

export const createNativePipelineFromPackage = ({
  binding,
  packageBytes,
}: NativePipelineFromPackageOptions): PreparedNativePipeline =>
  new PreparedNativePipeline(
    createNativeAnonymizerFromPackage({ binding, packageBytes }),
  );

export const PreparedSearch = PreparedNativeAnonymizer;
export type PreparedSearch = PreparedNativeAnonymizer;
export const PreparedAnonymizer = PreparedNativeAnonymizer;
export type PreparedAnonymizer = PreparedNativeAnonymizer;

const toBindingOperatorConfig = (
  config: NativeOperatorConfig | undefined,
): NativeBindingOperatorConfig | undefined => {
  if (!config) {
    return undefined;
  }
  const bindingConfig: NativeBindingOperatorConfig = {};
  if (config.operators !== undefined) {
    bindingConfig.operators = config.operators;
  }
  if (config.redactString !== undefined) {
    bindingConfig.redactString = config.redactString;
  }
  return bindingConfig;
};

const toNativeStaticRedactionResult = (
  result: NativeBindingStaticRedactionResult,
): NativeStaticRedactionResult => ({
  resolvedEntities: result.resolvedEntities.map(toNativePipelineEntity),
  redaction: toNativeRedactionResult(result.redaction),
});

const toBindingStaticRedactionResult = (
  result: NativeStaticRedactionResult,
): CanonicalStaticRedactionResult => ({
  resolved_entities: result.resolvedEntities.map(toBindingPipelineEntity),
  redaction: {
    redacted_text: result.redaction.redactedText,
    redaction_map: [...result.redaction.redactionMap.entries()].map(
      ([placeholder, original]) => ({ placeholder, original }),
    ),
    operator_map: [...result.redaction.operatorMap.entries()].map(
      ([placeholder, operator]) => ({ placeholder, operator }),
    ),
    entity_count: result.redaction.entityCount,
  },
});

const toNativePipelineEntity = (
  entity: NativeBindingPipelineEntity,
): NativePipelineEntity => ({
  start: entity.start,
  end: entity.end,
  label: entity.label,
  text: entity.text,
  score: entity.score,
  source: entity.source,
  ...(entity.sourceDetail ? { sourceDetail: entity.sourceDetail } : {}),
});

const toBindingPipelineEntity = ({
  sourceDetail,
  ...entity
}: NativePipelineEntity): CanonicalPipelineEntity => ({
  ...entity,
  source_detail: sourceDetail ?? null,
});

const toNativeRedactionResult = (
  result: NativeBindingRedactionResult,
): NativeRedactionResult => ({
  redactedText: result.redactedText,
  redactionMap: toRedactionMap(result.redactionMap),
  operatorMap: toOperatorMap(result.operatorMap),
  entityCount: result.entityCount,
});

const toRedactionMap = (
  entries: readonly NativeBindingRedactionEntry[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.placeholder, entry.original);
  }
  return map;
};

const toOperatorMap = (
  entries: readonly NativeBindingOperatorEntry[],
): Map<string, OperatorType> => {
  const map = new Map<string, OperatorType>();
  for (const entry of entries) {
    map.set(entry.placeholder, entry.operator);
  }
  return map;
};
