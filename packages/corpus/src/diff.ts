import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadManifest } from "./manifest";
import {
  assertValidRunName,
  RUN_SUMMARY_FILE,
  RUNS_DIR,
  rawPath,
} from "./paths";
import type { RunDocument, RunEntity, RunSummary, VerdictSpan } from "./types";
import {
  judgedVerdictsByKey,
  loadVerdictsForDoc,
  spanKey,
  validateVerdicts,
} from "./verdicts";

export type DocDiff = {
  docId: string;
  sha256: string;
  /** New, unjudged spans: FP candidates to triage. */
  added: RunEntity[];
  /** Disappeared, unjudged spans: FN candidates to triage. */
  removed: RunEntity[];
  /**
   * Judged-`tp` spans the current run no longer detects: real
   * regressions. Derived from the verdicts, so they surface with or
   * without a baseline run.
   */
  regressions: VerdictSpan[];
  /** Newly detected spans whose key was judged `fn`: known gaps now closed. */
  fixed: RunEntity[];
};

export type DiffDocumentsOptions = {
  current: RunDocument;
  /** Null compares against nothing: every unjudged span is a candidate. */
  baseline: RunDocument | null;
  /** Judged span by key; drives regression/fixed buckets and filtering. */
  judged: ReadonlyMap<string, VerdictSpan>;
};

export const diffDocuments = ({
  current,
  baseline,
  judged,
}: DiffDocumentsOptions): DocDiff => {
  const baselineKeys = new Set(
    (baseline?.entities ?? []).map((entity) => spanKey(entity)),
  );
  const currentKeys = new Set(
    current.entities.map((entity) => spanKey(entity)),
  );

  const added: RunEntity[] = [];
  const fixed: RunEntity[] = [];
  for (const entity of current.entities) {
    const key = spanKey(entity);
    if (baselineKeys.has(key)) {
      continue;
    }
    const verdict = judged.get(key)?.verdict;
    if (verdict === "fn") {
      // A span previously judged a miss is now detected: a fix.
      fixed.push(entity);
      continue;
    }
    // tp/fp are already accounted for; surface only unjudged new spans.
    if (verdict === undefined) {
      added.push(entity);
    }
  }

  const removed: RunEntity[] = [];
  for (const entity of baseline?.entities ?? []) {
    const key = spanKey(entity);
    // Judged spans never re-surface here: a vanished `fp` is expected,
    // and a vanished `tp` is reported via the verdict scan below.
    if (currentKeys.has(key) || judged.has(key)) {
      continue;
    }
    removed.push(entity);
  }

  // Regressions come from the verdicts, not the baseline: a span
  // judged `tp` that the current run misses is a real loss even on a
  // first run after checkout, when no baseline exists yet.
  const regressions: VerdictSpan[] = [];
  for (const span of judged.values()) {
    if (span.verdict === "tp" && !currentKeys.has(spanKey(span))) {
      regressions.push(span);
    }
  }

  return {
    docId: current.docId,
    sha256: current.sha256,
    added,
    removed,
    regressions,
    fixed,
  };
};

type LoadedRun = {
  docs: Map<string, RunDocument>;
  summary: RunSummary;
};

const loadRun = async (runName: string): Promise<LoadedRun> => {
  assertValidRunName(runName);
  const runDir = join(RUNS_DIR, runName);
  const summaryFile = Bun.file(join(runDir, RUN_SUMMARY_FILE));
  if (!(await summaryFile.exists())) {
    console.error(
      `run "${runName}" is missing ${RUN_SUMMARY_FILE}; it may be incomplete`,
    );
    process.exit(1);
  }
  const summary = (await summaryFile.json()) as RunSummary;
  const docs = new Map<string, RunDocument>();
  let files: string[];
  try {
    files = readdirSync(runDir);
  } catch {
    console.error(`run "${runName}" not found under ${RUNS_DIR}`);
    process.exit(1);
  }
  for (const file of files) {
    if (!file.endsWith(".json") || file === RUN_SUMMARY_FILE) {
      continue;
    }
    // SAFETY: run artifacts are only written by src/run.ts.
    const doc = (await Bun.file(join(runDir, file)).json()) as RunDocument;
    if (docs.has(doc.docId)) {
      console.error(`run "${runName}" has duplicate artifact for ${doc.docId}`);
      process.exit(1);
    }
    docs.set(doc.docId, doc);
  }
  const entityCount = [...docs.values()].reduce(
    (sum, doc) => sum + doc.entities.length,
    0,
  );
  if (
    docs.size !== summary.documentCount ||
    entityCount !== summary.entityCount
  ) {
    console.error(
      `run "${runName}" is incomplete: summary records ${summary.documentCount} documents/${summary.entityCount} entities, artifacts contain ${docs.size} documents/${entityCount} entities`,
    );
    process.exit(1);
  }
  return { docs, summary };
};

const isMainModule = import.meta.path === Bun.main;

if (isMainModule) {
  const usage = `Usage: bun src/diff.ts --run <name> [--baseline <name>]

Reports span changes in a run against an optional baseline:
  added        new, unjudged spans (FP candidates to triage)
  removed      disappeared, unjudged spans (FN candidates to triage)
  regressions  spans judged "tp" that the run no longer detects (real
               losses; reported with or without a baseline)
  fixed        newly detected spans previously judged "fn" (gaps closed)
Spans judged "tp"/"fp" are not re-surfaced as candidates; a vanished
"fp" is expected and dropped. JSON on stdout, summary on stderr.`;

  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      baseline: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help || !values.run) {
    console.error(usage);
    process.exit(values.help ? 0 : 1);
  }

  const current = await loadRun(values.run);
  const baseline = values.baseline ? await loadRun(values.baseline) : null;
  const manifest = await loadManifest();
  const textBySha = new Map(
    manifest.entries.map((entry) => [entry.sha256, rawPath(entry.id)]),
  );

  const diffs: DocDiff[] = [];
  let judgedSpanCount = 0;

  for (const doc of current.docs.values()) {
    const verdicts = await loadVerdictsForDoc(doc.sha256);
    if (verdicts) {
      const path = textBySha.get(doc.sha256);
      if (!path) {
        console.error(
          `verdicts for ${doc.docId} (${doc.sha256}) have no manifest entry; cannot validate offsets`,
        );
        process.exit(1);
      }
      const textFile = Bun.file(path);
      if (!(await textFile.exists())) {
        console.error(
          `missing raw text for ${doc.docId}; run fetch with --refill before diffing verdicts`,
        );
        process.exit(1);
      }
      const text = await textFile.text();
      for (const issue of validateVerdicts({ verdicts, text })) {
        console.error(
          `invalid verdict for ${doc.docId} span ${issue.spanIndex}: ${issue.message}`,
        );
        process.exit(1);
      }
      judgedSpanCount += verdicts.spans.length;
    }
    // Only diff against a baseline extracted from the same document text.
    // Span keys are offsets, so a baseline whose sha256 differs (the document
    // was re-extracted under the same id) would compare offsets across
    // unrelated content; treat a changed hash as having no baseline.
    const baselineDoc = baseline?.docs.get(doc.docId) ?? null;
    const diff = diffDocuments({
      current: doc,
      baseline: baselineDoc?.sha256 === doc.sha256 ? baselineDoc : null,
      judged: judgedVerdictsByKey(verdicts),
    });
    if (
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.regressions.length > 0 ||
      diff.fixed.length > 0
    ) {
      diffs.push(diff);
    }
  }

  const sumOf = (
    pick: (diff: DocDiff) => readonly (RunEntity | VerdictSpan)[],
  ): number => diffs.reduce((sum, diff) => sum + pick(diff).length, 0);

  const addedTotal = sumOf((diff) => diff.added);
  const removedTotal = sumOf((diff) => diff.removed);
  const regressionTotal = sumOf((diff) => diff.regressions);
  const fixedTotal = sumOf((diff) => diff.fixed);

  console.log(
    JSON.stringify(
      {
        run: values.run,
        baseline: values.baseline ?? null,
        documentsWithChanges: diffs.length,
        fpCandidates: addedTotal,
        fnCandidates: removedTotal,
        regressions: regressionTotal,
        fixed: fixedTotal,
        docs: diffs,
      },
      null,
      2,
    ),
  );
  console.error(
    `${diffs.length} documents changed: ${addedTotal} FP candidates, ` +
      `${removedTotal} FN candidates, ${regressionTotal} regressions, ` +
      `${fixedTotal} fixed (${judgedSpanCount} spans already judged)`,
  );
}
