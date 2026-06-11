import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadManifest } from "./manifest";
import { RUN_SUMMARY_FILE, RUNS_DIR, rawPath } from "./paths";
import type { RunDocument, RunEntity, VerdictSpan } from "./types";
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

const loadRunDocuments = async (
  runName: string,
): Promise<Map<string, RunDocument>> => {
  const runDir = join(RUNS_DIR, runName);
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
    docs.set(doc.sha256, doc);
  }
  return docs;
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

  const current = await loadRunDocuments(values.run);
  const baseline = values.baseline
    ? await loadRunDocuments(values.baseline)
    : null;
  const manifest = await loadManifest();
  const textBySha = new Map(
    manifest.entries.map((entry) => [entry.sha256, rawPath(entry.id)]),
  );

  const diffs: DocDiff[] = [];
  let judgedSpanCount = 0;

  for (const doc of current.values()) {
    const verdicts = await loadVerdictsForDoc(doc.sha256);
    if (verdicts) {
      const path = textBySha.get(doc.sha256);
      const text = path ? await Bun.file(path).text() : null;
      if (text !== null) {
        for (const issue of validateVerdicts({ verdicts, text })) {
          console.error(
            `invalid verdict for ${doc.docId} span ${issue.spanIndex}: ${issue.message}`,
          );
          process.exit(1);
        }
      }
      judgedSpanCount += verdicts.spans.length;
    }
    const diff = diffDocuments({
      current: doc,
      baseline: baseline?.get(doc.sha256) ?? null,
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
