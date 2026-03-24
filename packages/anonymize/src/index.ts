// ── Core Types ────────────────────────────────────
export type {
  Entity,
  ReviewedEntity,
  ReviewDecision,
  DetectionSource,
  DenyListCategory,
  GazetteerEntry,
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
export { createPipelineContext } from "./context";

// ── Pipeline ──────────────────────────────────────
export { runPipeline, mergeAndDedup } from "./pipeline";
export type { NerInferenceFn } from "./pipeline";

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
  scanExact,
  scanFuzzy,
  processGazetteerMatches,
  buildGazetteerPatterns,
} from "./detectors/gazetteer";
export {
  extractDefinedTerms,
  findCoreferenceSpans,
  corefSourceMap,
} from "./detectors/coreference";
export {
  detectNameCorpus,
  initNameCorpus,
} from "./detectors/names";

// ── Deny List Detector ──────────────────────────
export {
  buildDenyList,
  ensureDenyListData,
  processDenyListMatches,
} from "./detectors/deny-list";
export type { DenyListData } from "./detectors/deny-list";

// ── Unified Search ──────────────────────────────
export {
  buildUnifiedSearch,
} from "./build-unified-search";
export type {
  UnifiedSearchInstance,
  GazetteerData,
} from "./build-unified-search";
export {
  runUnifiedSearch,
} from "./unified-search";
export type { UnifiedResult } from "./unified-search";

// ── Regions ──────────────────────────────────────
export { REGIONS, resolveCountries } from "./regions";
export type { RegionId, CountryCode } from "./regions";

// ── Dictionaries ─────────────────────────────────
// Install @stll/anonymize-data for deny list
// dictionaries. Import directly from that package:
//   import { loadDictionary } from "@stll/anonymize-data"

// ── Filters ───────────────────────────────────────
export { filterFalsePositives } from "./filters/false-positives";
export { boostNearMissEntities } from "./filters/confidence-boost";

// ── GLiNER Computation ────────────────────────────
export { decodeSpans } from "./gliner/decoder";
export { decodeTokenSpans } from "./gliner/token-decoder";
export { prepareBatch, tokenizeText } from "./gliner/processor";
export type { EntityResult, RawInferenceResult } from "./gliner/types";

// ── Utilities ─────────────────────────────────────
export {
  chunkText,
  computeChunkOffsets,
  mergeChunkEntities,
} from "./util/chunker";
export { levenshtein } from "./util/levenshtein";
export { normalizeForSearch } from "./util/normalize";
