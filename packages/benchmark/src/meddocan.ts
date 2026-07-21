import { join } from "node:path";

import { createBenchmarkAdapters } from "./adapters";
import type { GroundTruthDocument } from "./ground-truth";
import { benchmarkGitRevision } from "./git-revision";
import { runSealedBoundary } from "./sealed-boundary";
import {
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type MeddocanAggregateMetrics,
  type SealedAggregateReport,
  type SealedLibraryResult,
  writeSealedAggregateReport,
} from "./sealed-report";
import { loadVerifiedMeddocan, MEDDOCAN_PROVENANCE } from "./suite/meddocan";
import { scoreSpanCorpus } from "./suite/span-score";

const RESULTS_DIR = join(import.meta.dir, "..", "results", "blind", "meddocan");
const documents = await runSealedBoundary(
  "MEDDOCAN verification or parsing",
  loadVerifiedMeddocan,
);
const inputs: GroundTruthDocument[] = documents.map(({ id, text }) => ({
  id,
  text,
  title: id,
  language: "es",
  entities: [],
}));
const libraries: SealedLibraryResult[] = [];
for (const adapter of createBenchmarkAdapters()) {
  process.stderr.write(`running sealed MEDDOCAN adapter ${adapter.name}...\n`);
  const start = performance.now();
  const outcome = await runSealedBoundary(
    `sealed adapter ${adapter.name}`,
    () => adapter.run(inputs),
  );
  const elapsedSeconds = (performance.now() - start) / 1000;
  if (outcome.status === "unavailable") {
    libraries.push({
      name: adapter.name,
      version: adapter.version,
      status: "unavailable",
      reasonCode: "adapter-unavailable",
    });
    continue;
  }
  const metrics: MeddocanAggregateMetrics = {
    type: "label-agnostic-span-redaction",
    ...scoreSpanCorpus(documents, outcome.predictions),
  };
  libraries.push({
    name: adapter.name,
    version: outcome.reportedVersion ?? adapter.version,
    status: "ok",
    elapsedSeconds,
    metrics,
  });
}

const report: SealedAggregateReport = {
  schemaVersion: SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  createdAt: new Date().toISOString(),
  gitSha: benchmarkGitRevision(),
  runtime: `Bun ${Bun.version}`,
  policy: "evaluation-only",
  corpus: {
    id: "meddocan",
    source: MEDDOCAN_PROVENANCE.repository,
    version: MEDDOCAN_PROVENANCE.version,
    file: MEDDOCAN_PROVENANCE.file,
    sha256: MEDDOCAN_PROVENANCE.sha256,
    license: MEDDOCAN_PROVENANCE.license,
    split: "test",
    documentCount: documents.length,
    selection: { type: "full-test-split" },
  },
  libraries,
};
const { jsonPath, markdownPath } = await writeSealedAggregateReport({
  directory: RESULTS_DIR,
  report,
});
process.stderr.write(
  `wrote aggregate-only sealed MEDDOCAN report:\n  ${jsonPath}\n  ${markdownPath}\n`,
);
