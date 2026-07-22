import { createRequire } from "node:module";

import type { NativePrediction } from "../../adapters/types";
import { outputIdentity } from "./identity";
import { regexDetectorConfig } from "./stella-config";
import type { CrossProviderId, ProviderSample } from "./types";

const provider = process.argv.at(2) as CrossProviderId | undefined;
if (provider !== "stella-full" && provider !== "stella-regex-detectors-only") {
  throw new Error("stella performance worker requires a stella provider id");
}

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

const request = (await new Response(Bun.stdin.stream()).json()) as {
  readonly inputBytes: number;
  readonly inputText: string;
  readonly inputSha256: string;
};
const initStarted = performance.now();
const anonymize = await import("@stll/anonymize");
const binding = anonymize.loadNativeAnonymizeBinding();
const commonConfig = {
  threshold: 0.3,
  language: "en",
  nameCorpusLanguages: ["en"],
  enableGazetteer: false,
  labels: [...anonymize.DEFAULT_ENTITY_LABELS],
  workspaceId: `cross-provider-performance-${provider}`,
};
const config =
  provider === "stella-full"
    ? {
        ...commonConfig,
        enableTriggerPhrases: true,
        enableRegex: true,
        enableLegalForms: true,
        enableNameCorpus: true,
        enableDenyList: true,
        enableConfidenceBoost: true,
        enableCoreference: true,
        enableHotwordRules: true,
        enableZoneClassification: true,
        dictionaries: await (
          await import("../../dictionaries")
        ).loadCorpusDictionaries("en"),
      }
    : {
        ...commonConfig,
        enableTriggerPhrases: false,
        enableRegex: true,
        enableLegalForms: false,
        enableNameCorpus: false,
        enableDenyList: false,
        enableCountries: false,
        enableConfidenceBoost: false,
        enableCoreference: false,
        enableHotwordRules: false,
        enableZoneClassification: false,
      };
type RedactText = (text: string) => {
  readonly resolvedEntities: readonly {
    readonly start: number;
    readonly end: number;
    readonly label: string;
    readonly text: string;
  }[];
};
let redactText: RedactText;
if (provider === "stella-full") {
  const pipeline = await anonymize.createNativePipelineFromConfig({
    binding,
    config,
    gazetteerEntries: [],
  });
  redactText = (text) => pipeline.redactText(text);
} else {
  const assembled = await anonymize.prepareNativePipelineConfig({
    binding,
    config,
  });
  const prepared = anonymize.createNativeAnonymizerFromConfig({
    binding,
    config: regexDetectorConfig(assembled),
  });
  redactText = (text) => prepared.redactStaticEntities(text);
}
const initSeconds = (performance.now() - initStarted) / 1000;

const detect = (): NativePrediction[] =>
  redactText(request.inputText).resolvedEntities.map(
    ({ start, end, label, text }) => ({
      start,
      end,
      label,
      text,
    }),
  );

const coldStarted = performance.now();
const cold = detect();
const coldSeconds = (performance.now() - coldStarted) / 1000;
const warmStarted = performance.now();
const warm = detect();
const warmSeconds = (performance.now() - warmStarted) / 1000;
const coldIdentity = outputIdentity(cold);
const warmIdentity = outputIdentity(warm);
if (
  coldIdentity.count !== warmIdentity.count ||
  coldIdentity.digest !== warmIdentity.digest
) {
  throw new Error("stella cold and warm outputs differ");
}

const require = createRequire(import.meta.url);
const version = (
  require("@stll/anonymize/package.json") as { readonly version: string }
).version;
const sample: ProviderSample = {
  provider,
  providerVersion: version,
  runtimeVersion: `Bun ${Bun.version}`,
  scope: provider === "stella-full" ? "full-pipeline" : "regex-detectors-only",
  inputBytes: request.inputBytes,
  inputCharacters: request.inputText.length,
  inputSha256: request.inputSha256,
  outputCount: warmIdentity.count,
  outputDigest: warmIdentity.digest,
  outputLabelCounts: warmIdentity.labelCounts,
  initSeconds,
  coldSeconds,
  warmSeconds,
};
process.stdout.write(`${JSON.stringify({ type: "result", sample })}\n`);
