// ── Core Types ────────────────────────────────────
export type {
  Entity,
  ReviewedEntity,
  ReviewDecision,
  DetectionSource,
  CustomDenyListEntry,
  CustomRegexPattern,
  DenyListCategory,
  Dictionaries,
  DictionaryMeta,
  GazetteerEntry,
  TriggerStrategy,
  TriggerValidation,
  TriggerExtension,
  TriggerGroupConfig,
  TriggerRule,
  OperatorType,
  OperatorConfig,
  AnonymisationOperator,
  RedactionResult,
  PipelineConfig,
} from "./types";
export {
  DETECTION_SOURCES,
  DETECTOR_PRIORITY,
  OPERATOR_TYPES,
  DEFAULT_ENTITY_LABELS,
} from "./types";

// ── Pipeline Context ─────────────────────────────
export type {
  DefinitionPattern,
  NameCorpusData,
  PipelineContext,
} from "./context";
export { corefKey, createPipelineContext } from "./context";

// ── Pipeline ──────────────────────────────────────
export {
  runPipeline,
  mergeAndDedup,
  sanitizeEntities,
  preparePipelineSearch,
} from "./pipeline";
export type {
  NerInferenceFn,
  PipelineOptions,
  PipelineSearchOptions,
} from "./pipeline";

// ── Native Adapter ───────────────────────────────
export {
  PreparedNativeAnonymizer,
  assertNativeBindingVersion,
  createNativeAnonymizerFromConfig,
  createNativeAnonymizerFromPackage,
  encodeNativeSearchConfig,
  getNativeBindingVersion,
  prepareNativeSearchPackage,
} from "./native";
export type {
  NativeAnonymizeBinding,
  NativeAnonymizerFromConfigOptions,
  NativeAnonymizerFromPackageOptions,
  NativeBindingVersionOptions,
  NativeOperatorConfig,
  NativePipelineEntity,
  NativePipelineFromPackageOptions,
  NativePreparedSearchBinding,
  NativeRedactionResult,
  NativeSearchPackageOptions,
  NativeStaticRedactionResult,
} from "./native";
export { DEFAULT_NATIVE_PIPELINE_CONFIG } from "./native-default-config";
export {
  PreparedNativePipeline,
  assertNativePipelineSupported,
  createNativePipelineFromConfig,
  createNativePipelineFromPackage,
  getNativePipelineCompatibility,
  prepareNativePipelineConfig,
  prepareNativePipelinePackage,
} from "./native-pipeline";
export type {
  NativePipelineBuildOptions,
  NativePipelineCompatibility,
  NativePipelinePackageOptions,
  NativePipelineUnsupportedFeature,
} from "./native-pipeline";

// ── Redaction ─────────────────────────────────────
export {
  redactText,
  deanonymise,
  exportRedactionKey,
  buildPlaceholderMap,
} from "./redact";

// ── Operators ─────────────────────────────────────
export {
  OPERATOR_REGISTRY,
  DEFAULT_OPERATOR_CONFIG,
  resolveOperator,
} from "./operators";

// ── Detectors ─────────────────────────────────────
export {
  REGEX_PATTERNS,
  REGEX_META,
  DATE_PATTERN_META,
  getDatePatterns,
  CURRENCY_PATTERN_META,
  getCurrencyPatterns,
  processRegexMatches,
} from "./detectors/regex";
export type { RegexMeta } from "./detectors/regex";
export {
  buildLegalFormPatterns,
  processLegalFormMatches,
  warmLegalRoleHeads,
} from "./detectors/legal-forms";
export {
  buildTriggerPatterns,
  processTriggerMatches,
} from "./detectors/triggers";
export {
  buildStreetTypePatterns,
  processAddressSeeds,
} from "./detectors/address-seeds";
export {
  processGazetteerMatches,
  buildGazetteerPatterns,
} from "./detectors/gazetteer";
export {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
export { propagateOrgNames } from "./detectors/org-propagation";
export {
  detectNameCorpus,
  initNameCorpus,
  getNameCorpusNonWesternNames,
} from "./detectors/names";

// ── Deny List Detector ──────────────────────────
export {
  buildDenyList,
  ensureDenyListData,
  processDenyListMatches,
} from "./detectors/deny-list";
export type { DenyListData } from "./detectors/deny-list";

// ── Unified Search ──────────────────────────────
export { buildUnifiedSearch } from "./build-unified-search";
export type {
  UnifiedSearchInstance,
  GazetteerData,
} from "./build-unified-search";
export { runUnifiedSearch } from "./unified-search";
export type { UnifiedResult } from "./unified-search";

// ── Regions ──────────────────────────────────────
export { REGIONS, resolveCountries } from "./regions";
export type { RegionId, CountryCode } from "./regions";

// ── Dictionaries ─────────────────────────────────
// Pass pre-loaded dictionary data via
// PipelineConfig.dictionaries. Load from the
// anonymize-data package in your consumer code.

// ── Filters ───────────────────────────────────────
export {
  filterFalsePositives,
  initAddressComponents,
} from "./filters/false-positives";
export { boostNearMissEntities } from "./filters/confidence-boost";
export { applyHotwordRules, initHotwordRules } from "./filters/hotword-rules";
export type { HotwordRule } from "./filters/hotword-rules";
export {
  classifyZones,
  applyZoneAdjustments,
  initZoneClassifier,
  ZONE_SCORE_ADJUSTMENTS,
} from "./filters/zone-classifier";
export type { DocumentZone, ZoneSpan } from "./filters/zone-classifier";

// ── GLiNER Computation ────────────────────────────
export { decodeSpans } from "./gliner/decoder";
export { decodeTokenSpans } from "./gliner/token-decoder";
export { prepareBatch, tokenizeText } from "./gliner/processor";
export type { EntityResult, RawInferenceResult } from "./gliner/types";

// ── GLiNER2 Sidecar ──────────────────────────────
export { buildGliner2Inference } from "./gliner2/inference";
export { Gliner2Client } from "./gliner2/client";
export type { Gliner2ClientOptions } from "./gliner2/client";
export type {
  InferRequest,
  InferResponse,
  EntityOutput,
  HealthResponse,
} from "./gliner2/types";

// ── Utilities ─────────────────────────────────────
export {
  chunkText,
  chunkTextWithOffsets,
  computeChunkOffsets,
  mergeChunkEntities,
} from "./util/chunker";
export type { ChunkSpan } from "./util/chunker";
export { levenshtein } from "./util/levenshtein";
export { normalizeForSearch } from "./util/normalize";
