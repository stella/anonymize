import { mkdirSync } from "node:fs";
import { cpus, arch, platform, totalmem } from "node:os";
import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import { scoreBlindCorpus, type BlindScore } from "./blind/score";
import {
  loadVerifiedTabTestCorpus,
  selectBlindSample,
  TAB_PROVENANCE,
  TAB_SAMPLE_SEED,
  TAB_SAMPLE_SIZE,
} from "./blind/tab";
import type { GroundTruthDocument } from "./ground-truth";

const RESULTS_DIR = join(import.meta.dir, "..", "results", "blind");

type LibraryResult =
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "ok";
      readonly elapsedSeconds: number;
      readonly score: BlindScore;
      readonly notes?: string | undefined;
    }
  | {
      readonly name: string;
      readonly version: string;
      readonly status: "unavailable";
      readonly reason: string;
    };

type BlindReport = {
  readonly createdAt: string;
  readonly gitSha: string;
  readonly runtime: string;
  readonly hardware: string;
  readonly policy: "evaluation-only";
  readonly corpus: {
    readonly repository: string;
    readonly commit: string;
    readonly file: string;
    readonly sha256: string;
    readonly license: string;
    readonly split: "test";
    readonly selection: "fixed-hash-sample" | "full-test-split";
    readonly selectionSeed?: string | undefined;
    readonly documents: number;
  };
  readonly libraries: readonly LibraryResult[];
};

const git = (args: readonly string[]): string => {
  try {
    const process = Bun.spawnSync(["git", ...args], {
      cwd: import.meta.dir,
    });
    if (!process.success || process.exitCode !== 0) {
      return "";
    }
    return process.stdout.toString().trim();
  } catch {
    return "";
  }
};

const gitSha = (): string => {
  const sha = git(["rev-parse", "--short", "HEAD"]) || "no-git";
  const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
  return `${sha}${dirty}`;
};

const hardware = (): string => {
  const gib = (totalmem() / 1024 ** 3).toFixed(0);
  return `${platform()}/${arch()}, ${cpus().length}x ${cpus().at(0)?.model ?? "unknown CPU"}, ${gib} GiB RAM`;
};

const percent = (value: number): string => (value * 100).toFixed(1);

const renderMarkdown = (report: BlindReport): string => {
  const lines = [
    "# Blind legal-text anonymization evaluation",
    "",
    "Evaluation-only results on the pinned TAB test split. Repository policy",
    "forbids using this corpus, its annotations, or its failures to tune stella.",
    "Reports contain aggregate metrics only.",
    "",
    `- Generated: ${report.createdAt}`,
    `- Commit: ${report.gitSha}`,
    `- Corpus commit: ${report.corpus.commit}`,
    `- Corpus SHA-256: \`${report.corpus.sha256}\``,
    `- Selection: ${report.corpus.selection} (${report.corpus.documents} documents)`,
    "",
    "A mention counts as covered only when the predicted mask fully contains its",
    "annotated span. Entity recall requires every masking-required mention of an",
    "entity to be covered. Metrics micro-average independent annotator judgments",
    "rather than treating their union as consensus. Character precision measures",
    "non-whitespace masked characters which belong to a direct or quasi identifier.",
    "",
    "| Library | Version | Direct recall | Quasi recall | All mention recall | Entity recall | Character precision | Character recall | Seconds |",
    "| ------- | ------- | ------------- | ------------ | ------------------ | ------------- | ------------------- | ---------------- | ------- |",
  ];
  for (const library of report.libraries) {
    if (library.status === "unavailable") {
      lines.push(
        `| ${library.name} | ${library.version} | unavailable | — | — | — | — | — | — |`,
      );
      continue;
    }
    lines.push(
      `| ${library.name} | ${library.version} | ${percent(library.score.directMentionRecall)} | ${percent(library.score.quasiMentionRecall)} | ${percent(library.score.allMentionRecall)} | ${percent(library.score.entityRecall)} | ${percent(library.score.characterPrecision)} | ${percent(library.score.characterRecall)} | ${library.elapsedSeconds.toFixed(2)} |`,
    );
  }
  const unavailable = report.libraries.filter(
    (library) => library.status === "unavailable",
  );
  if (unavailable.length > 0) {
    lines.push("", "## Unavailable adapters", "");
    for (const library of unavailable) {
      lines.push(`- **${library.name}:** ${library.reason}`);
    }
  }
  const notes = report.libraries.filter(
    (library): library is Extract<LibraryResult, { status: "ok" }> =>
      library.status === "ok" && library.notes !== undefined,
  );
  if (notes.length > 0) {
    lines.push("", "## Adapter notes", "");
    for (const library of notes) {
      lines.push(`- **${library.name}:** ${library.notes}`);
    }
  }
  lines.push(
    "",
    "## Interpretation limits",
    "",
    "- TAB contains English ECHR court decisions, not commercial contracts.",
    "- This score is label-agnostic: it evaluates masking coverage and utility,",
    "  not whether libraries agree on entity taxonomy.",
    "- The fixed sample is selected from document IDs by a committed hash seed",
    "  before predictions are produced. Use `--full` for all 127 test documents.",
    "- These results may approve or reject a release, but must never be used as",
    "  detector-development feedback.",
    "",
  );
  return `${lines.join("\n")}\n`;
};

const full = process.argv.slice(2).includes("--full");
const corpus = await loadVerifiedTabTestCorpus();
const selected = full ? corpus : selectBlindSample(corpus);
const documents: GroundTruthDocument[] = selected.map(({ id, text }) => ({
  id,
  text,
  language: "en",
  title: id,
  entities: [],
}));

const libraries: LibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(`running blind adapter ${adapter.name}...\n`);
  const start = performance.now();
  const outcome = await adapter.run(documents);
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
    score: scoreBlindCorpus(selected, outcome.predictions),
    notes: outcome.notes,
  });
}

const report: BlindReport = {
  createdAt: new Date().toISOString(),
  gitSha: gitSha(),
  runtime: `Bun ${Bun.version}`,
  hardware: hardware(),
  policy: "evaluation-only",
  corpus: {
    ...TAB_PROVENANCE,
    split: "test",
    selection: full ? "full-test-split" : "fixed-hash-sample",
    selectionSeed: full ? undefined : TAB_SAMPLE_SEED,
    documents: selected.length,
  },
  libraries,
};

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = report.createdAt.replace(/[:.]/gu, "-");
const jsonPath = join(RESULTS_DIR, `${stamp}.json`);
const markdownPath = join(RESULTS_DIR, `${stamp}.md`);
await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await Bun.write(markdownPath, renderMarkdown(report));
process.stderr.write(
  `wrote aggregate-only blind report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);

if (!full && selected.length !== TAB_SAMPLE_SIZE) {
  throw new Error("TAB fixed sample size invariant failed");
}
