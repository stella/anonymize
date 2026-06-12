/**
 * Throughput benchmark for the deterministic pipeline (NER off).
 *
 * Measures one-time costs (dictionary load, search preparation) and
 * steady-state per-document latency over the contract corpus:
 * --warmup full passes (default 2), then --iterations measured
 * passes (default 10); medians are reported.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, cpus, platform } from "node:os";
import { parseArgs } from "node:util";

import {
  createPipelineContext,
  preparePipelineSearch,
  runPipeline,
  type PipelineConfig,
} from "@stll/anonymize";

import { BENCH_PIPELINE_CONFIG } from "./adapters/anonymize";
import { loadBenchDictionaries } from "./dictionaries";
import { loadGoldDocuments } from "./fixtures";

const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUP = 2;

type DocumentStats = {
  id: string;
  language: string;
  chars: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  charsPerSecond: number;
};

type ThroughputReport = {
  generatedAt: string;
  environment: {
    bun: string;
    platform: string;
    arch: string;
    cpu: string;
  };
  settings: { iterations: number; warmup: number };
  oneTime: { dictionaryLoadMs: number; prepareMs: number };
  corpus: {
    docs: number;
    totalChars: number;
    medianPassMs: number;
    charsPerSecond: number;
  };
  documents: DocumentStats[];
};

const { values: args } = parseArgs({
  options: {
    iterations: { type: "string" },
    warmup: { type: "string" },
    out: { type: "string" },
  },
});

const iterations = Number(args.iterations ?? DEFAULT_ITERATIONS);
const warmup = Number(args.warmup ?? DEFAULT_WARMUP);
if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error(`--iterations must be a positive integer`);
}
if (!Number.isInteger(warmup) || warmup < 0) {
  throw new Error(`--warmup must be a non-negative integer`);
}

const elapsedMs = (startNs: number): number =>
  (Bun.nanoseconds() - startNs) / 1_000_000;

const median = (samples: number[]): number => {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted.at(middle - (sorted.length % 2 === 0 ? 1 : 0)) ?? 0;
  const upper = sorted.at(middle) ?? 0;
  return (lower + upper) / 2;
};

const roundMs = (ms: number): number => Math.round(ms * 1_000) / 1_000;

const docs = loadGoldDocuments();

const dictionaryStart = Bun.nanoseconds();
const dictionaries = await loadBenchDictionaries();
const dictionaryLoadMs = elapsedMs(dictionaryStart);

const config: PipelineConfig = { ...BENCH_PIPELINE_CONFIG, dictionaries };
const context = createPipelineContext();
const prepareStart = Bun.nanoseconds();
await preparePipelineSearch({ config, context });
const prepareMs = elapsedMs(prepareStart);

const runDocument = async (text: string): Promise<void> => {
  await runPipeline({
    fullText: text,
    config,
    gazetteerEntries: [],
    context,
  });
};

for (let pass = 0; pass < warmup; pass += 1) {
  for (const doc of docs) {
    await runDocument(doc.text);
  }
}

const samplesByDoc = new Map<string, number[]>(docs.map((doc) => [doc.id, []]));
const passSamples: number[] = [];
for (let pass = 0; pass < iterations; pass += 1) {
  let passMs = 0;
  for (const doc of docs) {
    const start = Bun.nanoseconds();
    await runDocument(doc.text);
    const ms = elapsedMs(start);
    passMs += ms;
    samplesByDoc.get(doc.id)?.push(ms);
  }
  passSamples.push(passMs);
}

const documents: DocumentStats[] = docs.map((doc) => {
  const samples = samplesByDoc.get(doc.id) ?? [];
  const medianMs = median(samples);
  return {
    id: doc.id,
    language: doc.language,
    chars: doc.text.length,
    medianMs: roundMs(medianMs),
    minMs: roundMs(Math.min(...samples)),
    maxMs: roundMs(Math.max(...samples)),
    charsPerSecond: Math.round(doc.text.length / (medianMs / 1_000)),
  };
});

const totalChars = docs.reduce((sum, doc) => sum + doc.text.length, 0);
const medianPassMs = median(passSamples);

const report: ThroughputReport = {
  generatedAt: new Date().toISOString(),
  environment: {
    bun: Bun.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus().at(0)?.model ?? "unknown",
  },
  settings: { iterations, warmup },
  oneTime: {
    dictionaryLoadMs: roundMs(dictionaryLoadMs),
    prepareMs: roundMs(prepareMs),
  },
  corpus: {
    docs: docs.length,
    totalChars,
    medianPassMs: roundMs(medianPassMs),
    charsPerSecond: Math.round(totalChars / (medianPassMs / 1_000)),
  },
  documents,
};

const outPath =
  args.out ?? join(import.meta.dir, "..", "results", "throughput.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  JSON.stringify({
    event: "throughput",
    medianPassMs: report.corpus.medianPassMs,
    charsPerSecond: report.corpus.charsPerSecond,
    dictionaryLoadMs: report.oneTime.dictionaryLoadMs,
    prepareMs: report.oneTime.prepareMs,
  }),
);
console.log(JSON.stringify({ event: "written", path: outPath }));
