/* Native entry point. The public package surface is intentionally thin:
 * TypeScript loads packages, translates types, and calls the Rust core.
 */

export * from "./native-node";
export {
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
export {
  DEFAULT_ENTITY_LABELS,
  DETECTION_SOURCES,
  DETECTOR_PRIORITY,
  ENTITY_CAPABILITIES,
  ENTITY_LABELS,
  ENTITY_SELECTIONS,
  OPERATOR_TYPES,
} from "./types";
export type {
  AnonymisationOperator,
  CustomDenyListEntry,
  CustomRegexPattern,
  DenyListCategory,
  DetectionSource,
  Dictionaries,
  DictionaryMeta,
  DefaultEntityLabel,
  Entity,
  EntityCapability,
  EntityLabel,
  EntitySelection,
  GazetteerEntry,
  OperatorConfig,
  OperatorType,
  PipelineConfig,
  RedactionResult,
  ReviewedEntity,
  ReviewDecision,
  TriggerExtension,
  TriggerGroupConfig,
  TriggerRule,
  TriggerStrategy,
  TriggerValidation,
} from "./types";
export { deanonymise, exportRedactionKey } from "./redact";
