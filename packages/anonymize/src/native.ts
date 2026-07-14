import type { NativePreparedSearchConfig } from "./native-search-config";
import type { OperatorSelection, OperatorType } from "./types";

export type { NativePreparedSearchConfig } from "./native-search-config";

type NativeBindingOperatorConfig = {
  operators?: Record<string, OperatorSelection>;
  redactString?: string;
};

type NativeBindingCallerRedactionOptions = {
  requestJson: string;
  operators?: NativeBindingOperatorConfig;
};

type NativeBindingOpenSessionArchiveOptions = {
  archive: Uint8Array;
  key: Uint8Array;
  expectedSessionId: string;
  observedAtEpochSeconds?: number;
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
  providerId?: string | null;
  detectionId?: string | null;
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
  provider_id?: string | null;
  detection_id?: string | null;
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

type CanonicalSessionMetadata = {
  session_id: string;
  created_at_epoch_seconds: number | null;
  expires_at_epoch_seconds: number | null;
  mapping_count: number;
  status: NativeSessionStatus;
};

type CanonicalSessionDeletionSummary = {
  session_id: string;
  deleted_mapping_count: number;
};

export type NativeSessionStatus =
  | "active"
  | "not_yet_active"
  | "expired"
  | "deleted";

export type NativeSessionLifecycle = {
  createdAtEpochSeconds: number;
  expiresAtEpochSeconds?: number;
};

export type NativeSessionMetadata = {
  sessionId: string;
  createdAtEpochSeconds: number | null;
  expiresAtEpochSeconds: number | null;
  mappingCount: number;
  status: NativeSessionStatus;
};

export type NativeSessionDeletionSummary = {
  sessionId: string;
  deletedMappingCount: number;
};

export type NativeSessionRedactionAtOptions = {
  fullText: string;
  observedAtEpochSeconds: number;
  operators?: NativeOperatorConfig;
};

export type NativeCreateSessionWithLifecycleOptions = NativeSessionLifecycle & {
  sessionId: string;
};

export type NativeOpenSessionArchiveOptions = {
  archive: Uint8Array;
  key: Uint8Array;
  expectedSessionId: string;
  observedAtEpochSeconds?: number;
};

export type NativePreparedRedactionSessionBinding = {
  sessionId: () => string;
  mappingCount: () => number;
  restoreText?: (fullText: string) => string;
  restoreTextAt?: (fullText: string, observedAtEpochSeconds: number) => string;
  toPlaintextJson: () => string;
  toPlaintextJsonAt?: (observedAtEpochSeconds: number) => string;
  toEncryptedArchive?: (key: Uint8Array) => Uint8Array;
  toEncryptedArchiveAt?: (
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ) => Uint8Array;
  inspectJson?: (observedAtEpochSeconds?: number) => string;
  deleteJson?: () => string;
  redactStaticEntitiesJson: (
    fullText: string,
    operators?: NativeBindingOperatorConfig,
  ) => string;
  redactStaticEntitiesJsonAt?: (
    fullText: string,
    observedAtEpochSeconds: number,
    operators?: NativeBindingOperatorConfig,
  ) => string;
};

export type NativePreparedSearchBinding = {
  prepareDiagnosticsJson?: () => string;
  warmLazyRegex?: () => void;
  warm_lazy_regex?: () => void;
  warmLazyRegexDiagnosticsJson?: () => string;
  warm_lazy_regex_diagnostics_json?: () => string;
  createRedactionSession?: (
    sessionId: string,
  ) => NativePreparedRedactionSessionBinding;
  createRedactionSessionWithLifecycle?: (
    sessionId: string,
    createdAtEpochSeconds: number,
    expiresAtEpochSeconds?: number,
  ) => NativePreparedRedactionSessionBinding;
  restoreRedactionSession?: (
    plaintextJson: string,
  ) => NativePreparedRedactionSessionBinding;
  restoreEncryptedRedactionSession?: (
    options: NativeBindingOpenSessionArchiveOptions,
  ) => NativePreparedRedactionSessionBinding;
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
  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson?: (
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
  operators?: Record<string, OperatorSelection>;
  redactString?: string;
};

export const CALLER_DETECTION_CONTRACT_VERSION = 2;

export type NativeCallerDetection = {
  start: number;
  end: number;
  label: string;
  score: number;
  providerId: string;
  detectionId: string;
};

export type NativeCallerRedactionOptions = {
  detections: readonly NativeCallerDetection[];
  operators?: NativeOperatorConfig;
};

const callerDetectionRequestJson = (
  detections: readonly NativeCallerDetection[],
): string =>
  JSON.stringify({
    version: CALLER_DETECTION_CONTRACT_VERSION,
    detections: detections.map((detection) => ({
      start: detection.start,
      end: detection.end,
      label: detection.label,
      score: detection.score,
      provider_id: detection.providerId,
      detection_id: detection.detectionId,
    })),
  });

export type NativePipelineEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
  sourceDetail?: string;
  providerId?: string;
  detectionId?: string;
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

export class PreparedNativeRedactionSession {
  readonly #session: NativePreparedRedactionSessionBinding;

  constructor(session: NativePreparedRedactionSessionBinding) {
    this.#session = session;
  }

  sessionId(): string {
    return this.#session.sessionId();
  }

  session_id(): string {
    return this.sessionId();
  }

  mappingCount(): number {
    return this.#session.mappingCount();
  }

  mapping_count(): number {
    return this.mappingCount();
  }

  restoreText(fullText: string, observedAtEpochSeconds?: number): string {
    if (observedAtEpochSeconds === undefined) {
      const restore = this.#session.restoreText;
      if (!restore) {
        throw new Error(
          "Native anonymize binding does not support session restoration",
        );
      }
      return restore.call(this.#session, fullText);
    }
    const restore = this.#session.restoreTextAt;
    if (!restore) {
      throw new Error(
        "Native anonymize binding does not support session restoration lifecycle controls",
      );
    }
    return restore.call(this.#session, fullText, observedAtEpochSeconds);
  }

  restore_text(fullText: string, observedAtEpochSeconds?: number): string {
    return this.restoreText(fullText, observedAtEpochSeconds);
  }

  toPlaintextJson(): string {
    return this.#session.toPlaintextJson();
  }

  to_plaintext_json(): string {
    return this.toPlaintextJson();
  }

  toPlaintextJsonAt(observedAtEpochSeconds: number): string {
    const serialize = this.#session.toPlaintextJsonAt;
    if (!serialize) {
      throw new Error(
        "Native anonymize binding does not support session lifecycle controls",
      );
    }
    return serialize.call(this.#session, observedAtEpochSeconds);
  }

  to_plaintext_json_at(observedAtEpochSeconds: number): string {
    return this.toPlaintextJsonAt(observedAtEpochSeconds);
  }

  toEncryptedArchive(key: Uint8Array): Uint8Array {
    const serialize = this.#session.toEncryptedArchive;
    if (!serialize) {
      throw new Error(
        "Native anonymize binding does not support encrypted session archives",
      );
    }
    return serialize.call(this.#session, key);
  }

  to_encrypted_archive(key: Uint8Array): Uint8Array {
    return this.toEncryptedArchive(key);
  }

  toEncryptedArchiveAt(
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ): Uint8Array {
    const serialize = this.#session.toEncryptedArchiveAt;
    if (!serialize) {
      throw new Error(
        "Native anonymize binding does not support encrypted session archives",
      );
    }
    return serialize.call(this.#session, key, observedAtEpochSeconds);
  }

  to_encrypted_archive_at(
    key: Uint8Array,
    observedAtEpochSeconds: number,
  ): Uint8Array {
    return this.toEncryptedArchiveAt(key, observedAtEpochSeconds);
  }

  inspect(observedAtEpochSeconds?: number): NativeSessionMetadata {
    const inspect = this.#session.inspectJson;
    if (!inspect) {
      throw new Error(
        "Native anonymize binding does not support session lifecycle controls",
      );
    }
    const metadata: CanonicalSessionMetadata = JSON.parse(
      inspect.call(this.#session, observedAtEpochSeconds),
    );
    return {
      sessionId: metadata.session_id,
      createdAtEpochSeconds: metadata.created_at_epoch_seconds,
      expiresAtEpochSeconds: metadata.expires_at_epoch_seconds,
      mappingCount: metadata.mapping_count,
      status: metadata.status,
    };
  }

  delete(): NativeSessionDeletionSummary {
    const deleteSession = this.#session.deleteJson;
    if (!deleteSession) {
      throw new Error(
        "Native anonymize binding does not support session lifecycle controls",
      );
    }
    const summary: CanonicalSessionDeletionSummary = JSON.parse(
      deleteSession.call(this.#session),
    );
    return {
      sessionId: summary.session_id,
      deletedMappingCount: summary.deleted_mapping_count,
    };
  }

  redactStaticEntities(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.redact_text_json(fullText, operators),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redactText(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntities(fullText, operators);
  }

  redact_text(
    fullText: string,
    operators?: NativeOperatorConfig,
  ): NativeStaticRedactionResult {
    return this.redactText(fullText, operators);
  }

  redactTextJson(fullText: string, operators?: NativeOperatorConfig): string {
    return this.redact_text_json(fullText, operators);
  }

  redact_text_json(fullText: string, operators?: NativeOperatorConfig): string {
    return this.#session.redactStaticEntitiesJson(
      fullText,
      toBindingOperatorConfig(operators),
    );
  }

  redactStaticEntitiesAt(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    const result: CanonicalStaticRedactionResult = JSON.parse(
      this.redactTextJsonAt(options),
    );
    return fromCanonicalStaticRedactionResult(result);
  }

  redactTextAt(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesAt(options);
  }

  redact_text_at(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactTextAt(options);
  }

  redact_static_entities_at(
    options: NativeSessionRedactionAtOptions,
  ): NativeStaticRedactionResult {
    return this.redactStaticEntitiesAt(options);
  }

  redactTextJsonAt({
    fullText,
    observedAtEpochSeconds,
    operators,
  }: NativeSessionRedactionAtOptions): string {
    const redact = this.#session.redactStaticEntitiesJsonAt;
    if (!redact) {
      throw new Error(
        "Native anonymize binding does not support session lifecycle controls",
      );
    }
    return redact.call(
      this.#session,
      fullText,
      observedAtEpochSeconds,
      toBindingOperatorConfig(operators),
    );
  }

  redact_text_json_at(options: NativeSessionRedactionAtOptions): string {
    return this.redactTextJsonAt(options);
  }
}

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

  createRedactionSession(sessionId: string): PreparedNativeRedactionSession {
    const create = this.#prepared.createRedactionSession;
    if (!create) {
      throw new Error(
        "Native anonymize binding does not support redaction sessions",
      );
    }
    return new PreparedNativeRedactionSession(
      create.call(this.#prepared, sessionId),
    );
  }

  create_redaction_session(sessionId: string): PreparedNativeRedactionSession {
    return this.createRedactionSession(sessionId);
  }

  createRedactionSessionWithLifecycle({
    sessionId,
    createdAtEpochSeconds,
    expiresAtEpochSeconds,
  }: NativeCreateSessionWithLifecycleOptions): PreparedNativeRedactionSession {
    const create = this.#prepared.createRedactionSessionWithLifecycle;
    if (!create) {
      throw new Error(
        "Native anonymize binding does not support session lifecycle controls",
      );
    }
    return new PreparedNativeRedactionSession(
      create.call(
        this.#prepared,
        sessionId,
        createdAtEpochSeconds,
        expiresAtEpochSeconds,
      ),
    );
  }

  create_redaction_session_with_lifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.createRedactionSessionWithLifecycle(options);
  }

  restoreRedactionSession(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    const restore = this.#prepared.restoreRedactionSession;
    if (!restore) {
      throw new Error(
        "Native anonymize binding does not support redaction sessions",
      );
    }
    return new PreparedNativeRedactionSession(
      restore.call(this.#prepared, plaintextJson),
    );
  }

  restore_redaction_session(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.restoreRedactionSession(plaintextJson);
  }

  restoreEncryptedRedactionSession({
    archive,
    key,
    expectedSessionId,
    observedAtEpochSeconds,
  }: NativeOpenSessionArchiveOptions): PreparedNativeRedactionSession {
    const restore = this.#prepared.restoreEncryptedRedactionSession;
    if (!restore) {
      throw new Error(
        "Native anonymize binding does not support encrypted session archives",
      );
    }
    return new PreparedNativeRedactionSession(
      restore.call(this.#prepared, {
        archive,
        key,
        expectedSessionId,
        ...(observedAtEpochSeconds === undefined
          ? {}
          : { observedAtEpochSeconds }),
      }),
    );
  }

  restore_encrypted_redaction_session(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.restoreEncryptedRedactionSession(options);
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
    const requestJson = callerDetectionRequestJson(options.detections);
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

  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string | null {
    const redact =
      this.#prepared.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson;
    if (!redact) {
      return null;
    }
    const requestJson = callerDetectionRequestJson(options.detections);
    const operators = toBindingOperatorConfig(options.operators);
    return redact.call(this.#prepared, fullText, {
      requestJson,
      ...(operators ? { operators } : {}),
    });
  }

  redact_static_entities_with_caller_detections_diagnostics_json(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string | null {
    return this.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
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

  createRedactionSession(sessionId: string): PreparedNativeRedactionSession {
    return this.#anonymizer.createRedactionSession(sessionId);
  }

  create_redaction_session(sessionId: string): PreparedNativeRedactionSession {
    return this.createRedactionSession(sessionId);
  }

  createRedactionSessionWithLifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.createRedactionSessionWithLifecycle(options);
  }

  create_redaction_session_with_lifecycle(
    options: NativeCreateSessionWithLifecycleOptions,
  ): PreparedNativeRedactionSession {
    return this.createRedactionSessionWithLifecycle(options);
  }

  restoreRedactionSession(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.restoreRedactionSession(plaintextJson);
  }

  restore_redaction_session(
    plaintextJson: string,
  ): PreparedNativeRedactionSession {
    return this.restoreRedactionSession(plaintextJson);
  }

  restoreEncryptedRedactionSession(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.#anonymizer.restoreEncryptedRedactionSession(options);
  }

  restore_encrypted_redaction_session(
    options: NativeOpenSessionArchiveOptions,
  ): PreparedNativeRedactionSession {
    return this.restoreEncryptedRedactionSession(options);
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

  redactTextWithCallerDetectionsDiagnosticsJson(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string | null {
    return this.#anonymizer.redactStaticEntitiesWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
  }

  redact_text_with_caller_detections_diagnostics_json(
    fullText: string,
    options: NativeCallerRedactionOptions,
  ): string | null {
    return this.redactTextWithCallerDetectionsDiagnosticsJson(
      fullText,
      options,
    );
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
    ({ source_detail, provider_id, detection_id, ...entity }) => ({
      ...entity,
      ...(source_detail ? { sourceDetail: source_detail } : {}),
      ...(provider_id ? { providerId: provider_id } : {}),
      ...(detection_id ? { detectionId: detection_id } : {}),
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
  ...(entity.providerId ? { providerId: entity.providerId } : {}),
  ...(entity.detectionId ? { detectionId: entity.detectionId } : {}),
});

const toBindingPipelineEntity = ({
  sourceDetail,
  providerId,
  detectionId,
  ...entity
}: NativePipelineEntity): CanonicalPipelineEntity => ({
  ...entity,
  source_detail: sourceDetail ?? null,
  provider_id: providerId ?? null,
  detection_id: detectionId ?? null,
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
