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

export type NativePreparedSearchBinding = {
  prepareDiagnosticsJson?: () => string;
  redactStaticEntities: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => NativeBindingStaticRedactionResult;
  redactStaticEntitiesDiagnosticsJson?: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
};

export type NativeAnonymizeBinding = {
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

export type NativeAnonymizerFromConfigOptions = {
  binding: NativeAnonymizeBinding;
  config: NativePreparedSearchConfig;
};

export type NativeAnonymizerFromPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

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

  redactStaticEntitiesDiagnosticsJson(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): string | null {
    const run = this.#prepared.redactStaticEntitiesDiagnosticsJson;
    if (!run) {
      return null;
    }
    return run(fullText, toBindingOperatorConfig(operators));
  }
}

export const encodeNativeSearchConfig = (
  config: NativePreparedSearchConfig,
): Uint8Array => new TextEncoder().encode(JSON.stringify(config));

export const getNativeBindingVersion = (
  binding: NativeAnonymizeBinding,
): string => binding.nativePackageVersion();

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
