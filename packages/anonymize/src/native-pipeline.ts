import {
  buildNativeStaticSearchBundle,
  type NativePreparedSearchConfig,
} from "./build-unified-search";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";
import type { GazetteerEntry, PipelineConfig } from "./types";
import {
  createNativeAnonymizerFromConfig,
  createNativeAnonymizerFromPackage,
  prepareNativeSearchPackage,
  PreparedNativeAnonymizer,
  type NativeAnonymizeBinding,
  type NativeOperatorConfig,
  type NativeStaticRedactionResult,
} from "./native";

export type NativePipelineUnsupportedFeature =
  | "enableNer"
  | "enableNameCorpus"
  | "enableCoreference"
  | "enableZoneClassification";

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

export type NativePipelineFromPackageOptions = {
  binding: NativeAnonymizeBinding;
  packageBytes: Uint8Array;
};

export class PreparedNativePipeline {
  readonly #anonymizer: PreparedNativeAnonymizer;

  constructor(anonymizer: PreparedNativeAnonymizer) {
    this.#anonymizer = anonymizer;
  }

  prepareDiagnosticsJson(): string | null {
    return this.#anonymizer.prepareDiagnosticsJson();
  }

  redactText(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.#anonymizer.redactStaticEntities(fullText, operators);
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
}

export const getNativePipelineCompatibility = (
  config: PipelineConfig,
): NativePipelineCompatibility => {
  const unsupportedFeatures: NativePipelineUnsupportedFeature[] = [];

  if (config.enableNer) unsupportedFeatures.push("enableNer");
  if (config.enableNameCorpus) unsupportedFeatures.push("enableNameCorpus");
  if (config.enableCoreference) unsupportedFeatures.push("enableCoreference");
  if (config.enableZoneClassification === true) {
    unsupportedFeatures.push("enableZoneClassification");
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
  const nativeConfig = await prepareNativePipelineConfig({
    config,
    gazetteerEntries,
    ...(context ? { context } : {}),
  });
  return prepareNativeSearchPackage({
    binding,
    config: nativeConfig,
    compressed,
  });
};

export const createNativePipelineFromConfig = async ({
  binding,
  config,
  gazetteerEntries = [],
  context,
}: NativePipelineBuildOptions): Promise<PreparedNativePipeline> => {
  const nativeConfig = await prepareNativePipelineConfig({
    config,
    gazetteerEntries,
    ...(context ? { context } : {}),
  });
  return new PreparedNativePipeline(
    createNativeAnonymizerFromConfig({
      binding,
      config: nativeConfig,
    }),
  );
};

export const createNativePipelineFromPackage = ({
  binding,
  packageBytes,
}: NativePipelineFromPackageOptions): PreparedNativePipeline =>
  new PreparedNativePipeline(
    createNativeAnonymizerFromPackage({ binding, packageBytes }),
  );
