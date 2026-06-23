import { DEFAULT_ENTITY_LABELS, type PipelineConfig } from "../types";

/**
 * Shared pipeline config for the contract fixture tests
 * (snapshots, quality, invariants). Every field is fixed; only
 * `workspaceId` varies per suite, so it is a parameter.
 */
export const contractTestConfig = (workspaceId: string): PipelineConfig => ({
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});
