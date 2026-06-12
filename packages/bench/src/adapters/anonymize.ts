import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
  type PipelineConfig,
} from "@stll/anonymize";

import { loadBenchDictionaries } from "../dictionaries";
import type { GoldDocument, PredictionsFile } from "../types";

/**
 * Deterministic layers only (NER off): identical to the config the
 * regression snapshots are generated with, so quality numbers and
 * throughput numbers describe the same pipeline.
 */
export const BENCH_PIPELINE_CONFIG: PipelineConfig = {
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
  workspaceId: "bench",
};

export const runAnonymizeAdapter = async (
  docs: GoldDocument[],
): Promise<PredictionsFile> => {
  const dictionaries = await loadBenchDictionaries();
  const config: PipelineConfig = { ...BENCH_PIPELINE_CONFIG, dictionaries };
  const context = createPipelineContext();
  const predictions: PredictionsFile = { tool: "anonymize", docs: [] };
  for (const doc of docs) {
    const entities = await runPipeline({
      fullText: doc.text,
      config,
      gazetteerEntries: [],
      context,
    });
    predictions.docs.push({
      id: doc.id,
      entities: entities.map(({ start, end, label }) => ({
        start,
        end,
        label,
      })),
    });
  }
  return predictions;
};
