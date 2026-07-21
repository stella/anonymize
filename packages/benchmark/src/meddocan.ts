import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import type { GroundTruthDocument } from "./ground-truth";
import { loadVerifiedMeddocan, MEDDOCAN_PROVENANCE } from "./suite/meddocan";
import { scoreSpanCorpus, type SpanScore } from "./suite/span-score";

const RESULTS_DIR = join(import.meta.dir, "..", "results", "blind", "meddocan");
type Result =
  | {
      name: string;
      version: string;
      status: "ok";
      seconds: number;
      score: SpanScore;
    }
  | { name: string; version: string; status: "unavailable"; reason: string };
const percent = (value: number): string => (value * 100).toFixed(1);

const documents = await loadVerifiedMeddocan();
const inputs: GroundTruthDocument[] = documents.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "es",
  entities: [],
}));
const libraries: Result[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(`running MEDDOCAN adapter ${adapter.name}...\n`);
  const start = performance.now();
  const outcome = await adapter.run(inputs);
  if (outcome.status === "unavailable") {
    libraries.push({
      name: adapter.name,
      version: adapter.version,
      status: "unavailable",
      reason: outcome.reason,
    });
  } else {
    libraries.push({
      name: adapter.name,
      version: outcome.reportedVersion ?? adapter.version,
      status: "ok",
      seconds: (performance.now() - start) / 1000,
      score: scoreSpanCorpus(documents, outcome.predictions),
    });
  }
}

const createdAt = new Date().toISOString();
const report = {
  createdAt,
  policy: "evaluation-only" as const,
  corpus: { ...MEDDOCAN_PROVENANCE, documents: documents.length },
  libraries,
};
const lines = [
  "# Blind Spanish clinical de-identification evaluation",
  "",
  "Evaluation-only aggregate results on the complete pinned MEDDOCAN test split.",
  "Development uses only the separate train/dev splits.",
  "",
  `- Generated: ${createdAt}`,
  `- Corpus DOI: ${MEDDOCAN_PROVENANCE.doi}`,
  `- Corpus SHA-256: \`${MEDDOCAN_PROVENANCE.sha256}\``,
  `- Documents: ${documents.length}`,
  "",
  "| Library | Version | Span recall | Character recall | Character precision | Seconds |",
  "| ------- | ------- | ----------- | ---------------- | ------------------- | ------- |",
];
for (const library of libraries) {
  lines.push(
    library.status === "unavailable"
      ? `| ${library.name} | ${library.version} | unavailable | — | — | — |`
      : `| ${library.name} | ${library.version} | ${percent(library.score.spanRecall)} | ${percent(library.score.characterRecall)} | ${percent(library.score.characterPrecision)} | ${library.seconds.toFixed(2)} |`,
  );
}
lines.push(
  "",
  "Metrics are label-agnostic and micro-averaged. A gold span counts as",
  "covered only when one prediction fully contains it.",
  "",
);
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = createdAt.replace(/[:.]/gu, "-");
await Bun.write(
  join(RESULTS_DIR, `${stamp}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
await Bun.write(join(RESULTS_DIR, `${stamp}.md`), `${lines.join("\n")}\n`);
process.stderr.write(
  `wrote aggregate-only MEDDOCAN report for ${documents.length} documents\n`,
);
