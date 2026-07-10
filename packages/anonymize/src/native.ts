import type { NativePreparedSearchConfig } from "./native-search-config";
import type { OperatorType } from "./types";

export type { NativePreparedSearchConfig } from "./native-search-config";

type NativeBindingOperatorConfig = {
  operators?: Record<string, OperatorType>;
  redactString?: string;
};

type NativeBindingCallerRedactionOptions = {
  requestJson: string;
  operators?: NativeBindingOperatorConfig;
};

export type NativeDiagnosticsBatchCallback = (diagnosticsJson: string) => void;
export type NativeResultEventCallback = (eventJson: string) => void;

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
  redactStaticEntitiesWithCallerDetectionsJson?: (
    fullText: string,
    options: NativeBindingCallerRedactionOptions,
  ) => string;
  redactStaticEntitiesResultStreamJson?: (
    fullText: string,
    operators: NativeBindingOperatorConfig | undefined,
    onEvent: NativeResultEventCallback,
  ) => string;
  redactStaticEntitiesDiagnosticsJson?: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesDiagnosticsStreamJson?: (
    fullText: string,
    operators: NativeBindingOperatorConfig | undefined,
    onBatch: NativeDiagnosticsBatchCallback,
  ) => string;
  redactStaticEntitiesSummaryDiagnosticsJson?: (
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
    fromPreparedPackageBytesWithoutCache?: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromTrustedPreparedPackageBytes?: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
    fromTrustedPreparedPackageBytesWithoutCache?: (
      packageBytes: Uint8Array,
    ) => NativePreparedSearchBinding;
  };
  prepareStaticSearchPackageBytes: (configJson: Uint8Array) => Uint8Array;
  prepareStaticSearchCompressedPackageBytes: (
    configJson: Uint8Array,
  ) => Uint8Array;
  // Rust config assembler (replaces the retired TypeScript config-assembly
  // layer). Takes the pipeline config plus out-of-band dictionaries and
  // gazetteer JSON and returns either the assembled config JSON or ready
  // package bytes. Optional so older bindings without the assembler still
  // satisfy the type; native-node loads them from the same `.node`.
  assembleStaticSearchConfigJson?: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
  assembleStaticSearchPackageBytes?: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
  assembleStaticSearchCompressedPackageBytes?: (
    pipelineConfigJson: Uint8Array,
    dictionariesJson?: Uint8Array,
    gazetteerJson?: Uint8Array,
  ) => Uint8Array;
};

export type NativeOperatorConfig = {
  operators?: Record<string, OperatorType>;
  redactString?: string;
};

export const CALLER_DETECTION_CONTRACT_VERSION = 1;

export type NativeCallerDetection = {
  start: number;
  end: number;
  label: string;
  score: number;
};

export type NativeCallerRedactionOptions = {
  detections: readonly NativeCallerDetection[];
  operators?: NativeOperatorConfig;
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

export type SharedNativeDiagnosticsStreamJsonOptions =
  SharedNativeRedactTextJsonOptions & {
    onBatch: NativeDiagnosticsBatchCallback;
  };

export type SharedNativeRedactTextStreamJsonOptions =
  SharedNativeRedactTextJsonOptions & {
    onEvent: NativeResultEventCallback;
  };

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

  redactStaticEntitiesWithCallerDetections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    if (!this.#prepared.redactStaticEntitiesWithCallerDetectionsJson) {
      throw new Error(
        "Native anonymize binding does not support caller detections",
      );
    }
    const requestJson = JSON.stringify({
      version: CALLER_DETECTION_CONTRACT_VERSION,
      detections: options.detections,
    });
    const operators = toBindingOperatorConfig(options.operators);
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.#prepared.redactStaticEntitiesWithCallerDetectionsJson(fullText, {
        requestJson,
        ...(operators ? { operators } : {}),
      }),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redact_text_with_caller_detections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesWithCallerDetections(fullText, options);
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redactTextStreamJson(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    if (!this.#prepared.redactStaticEntitiesResultStreamJson) {
      return null;
    }
    return this.#prepared.redactStaticEntitiesResultStreamJson(
      fullText,
      toBindingOperatorConfig(operators),
      onEvent,
    );
  }

  redact_text_stream_json(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactTextStreamJson(fullText, onEvent, operators);
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

  diagnosticsStreamJson(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    if (!this.#prepared.redactStaticEntitiesDiagnosticsStreamJson) {
      return null;
    }
    return this.#prepared.redactStaticEntitiesDiagnosticsStreamJson(
      fullText,
      toBindingOperatorConfig(operators),
      onBatch,
    );
  }

  diagnostics_stream_json(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  redactStaticEntitiesSummaryDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    if (!this.#prepared.redactStaticEntitiesSummaryDiagnosticsJson) {
      return null;
    }
    return this.#prepared.redactStaticEntitiesSummaryDiagnosticsJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  summary_diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactStaticEntitiesSummaryDiagnosticsJson(fullText, operators);
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
    return this.#anonymizer.redact_text_json(fullText, operators);
  }

  redactTextWithCallerDetections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.#anonymizer.redactStaticEntitiesWithCallerDetections(
      fullText,
      options,
    );
  }

  redact_text_with_caller_detections(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): NativeStaticRedactionResult {
    return this.redactTextWithCallerDetections(fullText, options);
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redactTextStreamJson(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.#anonymizer.redactTextStreamJson(fullText, onEvent, operators);
  }

  redact_text_stream_json(
    fullText: string,
    onEvent: NativeResultEventCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactTextStreamJson(fullText, onEvent, operators);
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

  diagnosticsStreamJson(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.#anonymizer.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  diagnostics_stream_json(
    fullText: string,
    onBatch: NativeDiagnosticsBatchCallback,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.diagnosticsStreamJson(fullText, onBatch, operators);
  }

  redactTextSummaryDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.#anonymizer.redactStaticEntitiesSummaryDiagnosticsJson(
      fullText,
      operators,
    );
  }

  summary_diagnostics_json(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    return this.redactTextSummaryDiagnosticsJson(fullText, operators);
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
  compressed = false,
}: NativeSearchPackageOptions): Uint8Array => {
  const configBytes = encodeNativeSearchConfig(config);
  return compressed
    ? binding.prepareStaticSearchCompressedPackageBytes(configBytes)
    : binding.prepareStaticSearchPackageBytes(configBytes);
};

export const prepare_search_package = ({
  binding,
  config,
  compressed = false,
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

export const redact_text_stream_json = ({
  binding,
  config,
  fullText,
  operators,
  onEvent,
}: SharedNativeRedactTextStreamJsonOptions): string | null =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).redact_text_stream_json(fullText, onEvent, operators);

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

export const diagnostics_stream_json = ({
  binding,
  config,
  fullText,
  operators,
  onBatch,
}: SharedNativeDiagnosticsStreamJsonOptions): string | null =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).diagnostics_stream_json(fullText, onBatch, operators);

export const summary_diagnostics_json = ({
  binding,
  config,
  fullText,
  operators,
}: SharedNativeDiagnosticsJsonOptions): string | null =>
  new PreparedNativeAnonymizer(
    binding.NativePreparedSearch.fromConfigJsonBytes(
      encodeNativeSearchConfigInput(config),
    ),
  ).summary_diagnostics_json(fullText, operators);

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

const fromCanonicalStaticRedactionResult = (
  result: CanonicalStaticRedactionResult,
): NativeStaticRedactionResult => ({
  resolvedEntities: result.resolved_entities.map(
    ({ source_detail, ...entity }) => ({
      ...entity,
      ...(source_detail ? { sourceDetail: source_detail } : {}),
    }),
  ),
  redaction: {
    redactedText: result.redaction.redacted_text,
    redactionMap: toRedactionMap(result.redaction.redaction_map),
    operatorMap: toOperatorMap(result.redaction.operator_map),
    entityCount: result.redaction.entity_count,
  },
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
