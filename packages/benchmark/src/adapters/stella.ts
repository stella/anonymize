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
  type AdapterOutcome,
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
 * Build every language-specific pipeline before either measured corpus pass.
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
    // one-time setup is timed here too. For stella that means loading the
    // language-scoped dictionaries and the native binding, plus building each
    // language pipeline. This is the analogue of Presidio's spaCy model load,
    // so the reported init cost is comparable across libraries.
    return runStllAdapterWithInitializer(docs, async () => {
      const binding = loadNativeAnonymizeBinding();
      return async (language) => {
        return createNativePipelineFromConfig({
          binding,
          config: await loadStllBenchmarkConfig(language),
          gazetteerEntries: [],
        });
      };
    });
  },
});
