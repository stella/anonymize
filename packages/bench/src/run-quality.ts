/**
 * Scores tool predictions against the reference annotations.
 *
 * Default run executes the anonymize pipeline in-process. Pass
 * --predictions <file.json> (PredictionsFile shape) to score an
 * external tool's output on the same corpus instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { runAnonymizeAdapter } from "./adapters/anonymize";
import { loadGoldDocuments } from "./fixtures";
import {
  type LabelCounts,
  type LabelMetrics,
  type MatchMode,
  mergeCounts,
  microCounts,
  scoreDocument,
  toMetrics,
} from "./scorer";
import type { PredictionsFile } from "./types";

const MATCH_MODES: readonly MatchMode[] = ["exact", "overlap"];

type ModeReport = {
  micro: LabelMetrics;
  perLabel: Record<string, LabelMetrics>;
  perLanguage: Record<string, LabelMetrics>;
};

type QualityReport = {
  tool: string;
  generatedAt: string;
  corpus: {
    docs: number;
    docsPerLanguage: Record<string, number>;
    goldEntities: number;
  };
  labelsFilter: string[] | null;
  modes: Record<MatchMode, ModeReport>;
};

const { values: args } = parseArgs({
  options: {
    predictions: { type: "string" },
    labels: { type: "string" },
    out: { type: "string" },
  },
});

const labelsFilter = args.labels?.split(",").map((label) => label.trim());

const docs = loadGoldDocuments();
const predictions: PredictionsFile = args.predictions
  ? // SAFETY: --predictions files are produced by bench adapters with this shape
    (JSON.parse(readFileSync(args.predictions, "utf8")) as PredictionsFile)
  : await runAnonymizeAdapter(docs);

const predictionsById = new Map(
  predictions.docs.map((doc) => [doc.id, doc.entities]),
);

const missingDocs = docs.filter((doc) => !predictionsById.has(doc.id));
if (missingDocs.length > 0) {
  const ids = missingDocs.map((doc) => doc.id).join(", ");
  throw new Error(`predictions missing for: ${ids}`);
}

const buildModeReport = (mode: MatchMode): ModeReport => {
  const totalCounts = new Map<string, LabelCounts>();
  const languageCounts = new Map<string, Map<string, LabelCounts>>();
  for (const doc of docs) {
    const documentCounts = scoreDocument({
      gold: doc.gold,
      predicted: predictionsById.get(doc.id) ?? [],
      mode,
      labels: labelsFilter,
    });
    mergeCounts(totalCounts, documentCounts);
    const perLanguage =
      languageCounts.get(doc.language) ?? new Map<string, LabelCounts>();
    mergeCounts(perLanguage, documentCounts);
    languageCounts.set(doc.language, perLanguage);
  }

  const perLabel: Record<string, LabelMetrics> = {};
  for (const label of [...totalCounts.keys()].toSorted()) {
    const counts = totalCounts.get(label);
    if (counts) perLabel[label] = toMetrics(counts);
  }
  const perLanguage: Record<string, LabelMetrics> = {};
  for (const [language, counts] of languageCounts) {
    perLanguage[language] = toMetrics(microCounts(counts));
  }
  return { micro: toMetrics(microCounts(totalCounts)), perLabel, perLanguage };
};

const docsPerLanguage: Record<string, number> = {};
for (const doc of docs) {
  docsPerLanguage[doc.language] = (docsPerLanguage[doc.language] ?? 0) + 1;
}

const report: QualityReport = {
  tool: predictions.tool,
  generatedAt: new Date().toISOString(),
  corpus: {
    docs: docs.length,
    docsPerLanguage,
    goldEntities: docs.reduce((sum, doc) => sum + doc.gold.length, 0),
  },
  labelsFilter: labelsFilter ?? null,
  modes: {
    exact: buildModeReport("exact"),
    overlap: buildModeReport("overlap"),
  },
};

const outPath =
  args.out ??
  join(import.meta.dir, "..", "results", `quality.${predictions.tool}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

for (const mode of MATCH_MODES) {
  const { micro } = report.modes[mode];
  console.log(
    JSON.stringify({
      event: "quality",
      tool: predictions.tool,
      mode,
      precision: micro.precision,
      recall: micro.recall,
      f1: micro.f1,
    }),
  );
}
console.log(JSON.stringify({ event: "written", path: outPath }));
