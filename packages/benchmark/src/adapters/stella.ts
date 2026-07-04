import { createRequire } from "node:module";

import {
  createNativePipelineFromConfig,
  DEFAULT_ENTITY_LABELS,
  loadNativeAnonymizeBinding,
  type PipelineConfig,
} from "@stll/anonymize";

import { loadCorpusDictionaries } from "../dictionaries";
import type { GroundTruthDocument } from "../ground-truth";
import {
  type Adapter,
  type NativePrediction,
  runTwoPassInProcess,
} from "./types";

const require = createRequire(import.meta.url);
const stellaVersion = (
  require("@stll/anonymize/package.json") as { version: string }
).version;

/**
 * stella (`@stll/anonymize`) native pipeline. Uses the canonical rules
 * configuration (NER off), identical to the corpus evaluation tooling and the
 * product default: trigger phrases, regex, legal forms, name corpus, deny list,
 * coreference, hotwords, zone classification. This is a deterministic,
 * model-free run; no external ML model is loaded.
 */
const buildConfig = (
  dictionaries: Awaited<ReturnType<typeof loadCorpusDictionaries>>,
): PipelineConfig => ({
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
  workspaceId: "benchmark-run",
  dictionaries,
});

export const createStllAdapter = (): Adapter => ({
  name: "stella",
  version: stellaVersion,
  run: async (docs: readonly GroundTruthDocument[]) => {
    // Init boundary (fairness): everything a competitor loads in its own
    // one-time setup is timed here too. For stella that means loading the
    // full bundled dictionaries and the native binding, plus building the
    // pipeline. This is the analogue of Presidio's spaCy model load, so the
    // reported init cost is comparable across libraries.
    const initStart = performance.now();
    const dictionaries = await loadCorpusDictionaries();
    const binding = loadNativeAnonymizeBinding();
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: buildConfig(dictionaries),
      gazetteerEntries: [],
    });
    const initSeconds = (performance.now() - initStart) / 1000;

    const processDoc = (text: string): NativePrediction[] =>
      pipeline
        .redactText(text)
        .resolvedEntities.map(({ start, end, label, text: value }) => ({
          start,
          end,
          label,
          text: value,
        }));

    return runTwoPassInProcess(docs, processDoc, initSeconds);
  },
});
