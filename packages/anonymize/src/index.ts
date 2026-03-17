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
  OPERATOR_TYPES,
  DEFAULT_ENTITY_LABELS,
} from "./types";

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
export { detectRegexPii } from "./detectors/regex";
export { detectTriggerPhrases } from "./detectors/triggers";
export { scanExact, scanFuzzy } from "./detectors/gazetteer";
export {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";
export { detectLegalFormEntities } from "./detectors/legal-forms";
export { detectNameCorpus } from "./detectors/names";

// ── Deny List Detector ──────────────────────────
export { buildDenyList, scanDenyList } from "./detectors/deny-list";
export type { DenyListAutomaton } from "./detectors/deny-list";

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
