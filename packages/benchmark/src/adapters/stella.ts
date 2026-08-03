import { createRequire } from "node:module";

import {
  DEFAULT_ENTITY_LABELS,
  getDefaultNativePipeline,
  loadNativeAnonymizeBinding,
  type PipelineConfig,
} from "@stll/anonymize";

import { loadCorpusDictionaries } from "../dictionaries";
import type { GroundTruthDocument } from "../ground-truth";
import {
  type Adapter,
  type AdapterOutcome,
  type NativePrediction,
  runTwoPassInProcess,
} from "./types";

const require = createRequire(import.meta.url);
const stellaVersion = (
  require("@stll/anonymize/package.json") as { version: string }
).version;
const STELLA_BENCHMARK_NOTES =
  "shipped language-scoped prepared packages; product-default rules and dictionaries; NER disabled";

/**
 * Caller-owned config used by assisted and config-assembly benchmark lanes.
 * The default comparison below loads stella's shipped product artifacts.
 */
export const buildStllBenchmarkConfig = (
  dictionaries: Awaited<ReturnType<typeof loadCorpusDictionaries>>,
  language: string,
): PipelineConfig => ({
  threshold: 0.3,
  language,
  nameCorpusLanguages: [language],
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "benchmark-run",
  dictionaries,
});

export const loadStllBenchmarkConfig = async (
  language: string,
): Promise<PipelineConfig> =>
  buildStllBenchmarkConfig(await loadCorpusDictionaries(language), language);

type StllBenchmarkPipeline = {
  readonly redactText: (text: string) => {
    readonly resolvedEntities: readonly {
      readonly start: number;
      readonly end: number;
      readonly label: string;
      readonly text: string;
    }[];
  };
};

type StllPipelineFactory = (language: string) => Promise<StllBenchmarkPipeline>;

type StllPipelineInitializer = () => Promise<StllPipelineFactory>;

const normalizeDocumentLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("benchmark document language must not be empty");
  }
  return normalized;
};

/**
 * Initialize every language-specific pipeline before either measured corpus pass.
 * Sorting makes construction order independent of document order; both passes
 * then reuse the exact same per-language instances.
 */
export const runStllAdapterWithInitializer = async (
  docs: readonly GroundTruthDocument[],
  initialize: StllPipelineInitializer,
): Promise<AdapterOutcome> => {
  const initStart = performance.now();
  const createPipeline = await initialize();
  const languages = [
    ...new Set(docs.map((doc) => normalizeDocumentLanguage(doc.language))),
  ].sort();
  const pipelines = new Map<string, StllBenchmarkPipeline>();
  for (const language of languages) {
    pipelines.set(language, await createPipeline(language));
  }
  const initSeconds = (performance.now() - initStart) / 1000;

  const processDoc = (doc: GroundTruthDocument): NativePrediction[] => {
    const language = normalizeDocumentLanguage(doc.language);
    const pipeline = pipelines.get(language);
    if (pipeline === undefined) {
      throw new Error(`missing stella benchmark pipeline for ${language}`);
    }
    return pipeline
      .redactText(doc.text)
      .resolvedEntities.map(({ start, end, label, text }) => ({
        start,
        end,
        label,
        text,
      }));
  };

  return runTwoPassInProcess(docs, processDoc, initSeconds);
};

export const createStllAdapter = (): Adapter => ({
  name: "stella",
  version: stellaVersion,
  run: async (docs: readonly GroundTruthDocument[]) => {
    // Init boundary (fairness): everything a competitor loads in its own
    // one-time setup is timed here too. The released stella package ships
    // language-scoped prepared pipelines, so benchmark the normal product path:
    // load each trusted artifact instead of rebuilding it from dictionaries.
    // Lazy regex compilation remains in the first measured corpus pass.
    const outcome = await runStllAdapterWithInitializer(docs, () => {
      const binding = loadNativeAnonymizeBinding();
      return Promise.resolve((language: string) =>
        Promise.resolve(
          getDefaultNativePipeline({
            binding,
            language,
            warmup: "none",
          }),
        ),
      );
    });
    return outcome.status === "ok"
      ? { ...outcome, notes: STELLA_BENCHMARK_NOTES }
      : outcome;
  },
});
