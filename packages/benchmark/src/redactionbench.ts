import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import type { GroundTruthDocument } from "./ground-truth";
import {
  loadVerifiedRedactionBench,
  REDACTIONBENCH_PROVENANCE,
} from "./suite/redactionbench";
import {
  scoreRedactionBench,
  type RedactionBenchScore,
} from "./suite/redactionbench-score";

const RESULTS_DIR = join(
  import.meta.dir,
  "..",
  "results",
  "blind",
  "redactionbench",
);

type LibraryResult =
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "ok";
      readonly elapsedSeconds: number;
      readonly score: RedactionBenchScore;
      readonly notes?: string | undefined;
    }
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "unavailable";
      readonly reason: string;
    };

const git = (args: readonly string[]): string => {
  try {
    const process = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir });
    return process.success ? process.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};

const percent = (value: number): string => (value * 100).toFixed(1);

const documents = await loadVerifiedRedactionBench();
const inputs: GroundTruthDocument[] = documents.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "en",
  entities: [],
}));

const libraries: LibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(`running RedactionBench adapter ${adapter.name}...\n`);
  const start = performance.now();
  const outcome = await adapter.run(inputs);
  const elapsedSeconds = (performance.now() - start) / 1000;
  if (outcome.status === "unavailable") {
    libraries.push({
      name: adapter.name,
      version: adapter.version,
      status: "unavailable",
      reason: outcome.reason,
    });
    continue;
  }
  libraries.push({
    name: adapter.name,
    version: outcome.reportedVersion ?? adapter.version,
    status: "ok",
    elapsedSeconds,
    score: scoreRedactionBench(documents, outcome.predictions),
    notes: outcome.notes,
  });
}

const sha = git(["rev-parse", "--short", "HEAD"]) || "no-git";
const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
const report = {
  createdAt: new Date().toISOString(),
  gitSha: `${sha}${dirty}`,
  policy: "evaluation-only" as const,
  metricStatus: "transparent-interim-not-official-r-score" as const,
  corpus: {
    ...REDACTIONBENCH_PROVENANCE,
    documents: documents.length,
    syntheticDocuments: documents.filter(({ synthetic }) => synthetic).length,
    realSourceDocuments: documents.filter(({ synthetic }) => !synthetic).length,
  },
  libraries,
};

const lines = [
  "# Blind heterogeneous-document anonymization evaluation",
  "",
  "Evaluation-only results on the complete pinned RedactionBench test split.",
  "The corpus, annotations, categories, and failures must not be used to tune",
  "stella. This report contains aggregate metrics only.",
  "",
  `- Generated: ${report.createdAt}`,
  `- Commit: ${report.gitSha}`,
  `- Corpus commit: ${report.corpus.commit}`,
  `- Corpus SHA-256: \`${report.corpus.sha256}\``,
  `- Documents: ${report.corpus.documents} (${report.corpus.realSourceDocuments} public-source, randomized; ${report.corpus.syntheticDocuments} synthetic)`,
  "",
  "> The RedactionBench authors have not yet published the official R-Score",
  "> implementation. These are explicitly named interim metrics, not R-Score.",
  "",
  "Mandatory span recall requires a prediction to fully contain a mandatory",
  "span. Mandatory character recall measures non-whitespace required characters",
  "masked. Accepted character precision treats both mandatory and contextual",
  "annotated characters as valid masks.",
  "",
  "| Library | Version | Mandatory span recall | Mandatory character recall | Accepted character precision | Seconds |",
  "| ------- | ------- | --------------------- | -------------------------- | ---------------------------- | ------- |",
];
for (const library of libraries) {
  if (library.status === "unavailable") {
    lines.push(
      `| ${library.name} | ${library.version} | unavailable | — | — | — |`,
    );
  } else {
    lines.push(
      `| ${library.name} | ${library.version} | ${percent(library.score.mandatorySpanRecall)} | ${percent(library.score.mandatoryCharacterRecall)} | ${percent(library.score.acceptedCharacterPrecision)} | ${library.elapsedSeconds.toFixed(2)} |`,
    );
  }
}
lines.push(
  "",
  "## Interpretation limits",
  "",
  "- The corpus is English and intentionally heterogeneous; it is not a legal,",
  "  clinical, or regulatory deployment certification.",
  "- The 101 public-source documents were transcribed, augmented, and had",
  "  entities randomized; they are not untouched originals or real PII.",
  "- Character precision is policy-neutral only because contextual spans are",
  "  accepted without asserting that they must be redacted.",
  "- Results may gate a release but must not provide detector-development",
  "  feedback.",
  "",
);

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = report.createdAt.replace(/[:.]/gu, "-");
const jsonPath = join(RESULTS_DIR, `${stamp}.json`);
const markdownPath = join(RESULTS_DIR, `${stamp}.md`);
await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await Bun.write(markdownPath, `${lines.join("\n")}\n`);
process.stderr.write(
  `wrote aggregate-only RedactionBench report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
