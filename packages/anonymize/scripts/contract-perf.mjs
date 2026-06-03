import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  preparePipelineSearch,
  runPipeline,
} from "../src/index.ts";
import { loadTestDictionaries } from "../src/__test__/load-dictionaries.ts";

const DEFAULT_MAX_PIPELINE_MS = 1_000;
const DEFAULT_MAX_TOTAL_MS = 1_500;

const maxPipelineMs = Number(
  process.env.ANONYMIZE_CONTRACT_MAX_PIPELINE_MS ?? DEFAULT_MAX_PIPELINE_MS,
);
const maxTotalMs = Number(
  process.env.ANONYMIZE_CONTRACT_MAX_TOTAL_MS ?? DEFAULT_MAX_TOTAL_MS,
);

const fixturesDir = join(
  import.meta.dir,
  "..",
  "src",
  "__test__",
  "fixtures",
  "contracts",
);

const fixturePaths = [];
for (const language of readdirSync(fixturesDir)) {
  const languageDir = join(fixturesDir, language);
  for (const file of readdirSync(languageDir)) {
    if (file.endsWith(".txt")) {
      fixturePaths.push(join(languageDir, file));
    }
  }
}
fixturePaths.sort((a, b) => a.localeCompare(b));

const dictionaryStart = Bun.nanoseconds();
const dictionaries = await loadTestDictionaries();
const dictionaryMs = elapsedMs(dictionaryStart);

const config = {
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
  workspaceId: "contract-perf",
  dictionaries,
};

const context = createPipelineContext();
const prepareStart = Bun.nanoseconds();
await preparePipelineSearch({ config, context });
const prepareMs = elapsedMs(prepareStart);

const totalStart = Bun.nanoseconds();
let pipelineMs = 0;

for (const fixturePath of fixturePaths) {
  const fullText = readFileSync(fixturePath, "utf8");
  const start = Bun.nanoseconds();
  const entities = await runPipeline({
    fullText,
    config,
    gazetteerEntries: [],
    context,
  });
  const ms = elapsedMs(start);
  pipelineMs += ms;
  console.log(
    JSON.stringify({
      event: "fixture",
      fixture: relative(fixturesDir, fixturePath),
      ms,
      entityCount: entities.length,
    }),
  );
}

const totalMs = elapsedMs(totalStart);
console.log(
  JSON.stringify({
    event: "summary",
    fixtures: fixturePaths.length,
    dictionaryMs,
    prepareMs,
    pipelineMs: roundMs(pipelineMs),
    totalMs,
    maxPipelineMs,
    maxTotalMs,
  }),
);

if (pipelineMs > maxPipelineMs) {
  throw new Error(
    `contract pipeline exceeded ${maxPipelineMs}ms: ${pipelineMs.toFixed(2)}ms`,
  );
}

if (totalMs > maxTotalMs) {
  throw new Error(
    `contract total exceeded ${maxTotalMs}ms: ${totalMs.toFixed(2)}ms`,
  );
}

function elapsedMs(start) {
  return roundMs((Bun.nanoseconds() - start) / 1_000_000);
}

function roundMs(ms) {
  return Math.round(ms * 1_000) / 1_000;
}
