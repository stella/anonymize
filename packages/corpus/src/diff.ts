import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadManifest } from "./manifest";
import { RUN_SUMMARY_FILE, RUNS_DIR, rawPath } from "./paths";
import type { RunDocument, RunEntity } from "./types";
import {
  judgedKeys,
  loadVerdictsForDoc,
  spanKey,
  validateVerdicts,
} from "./verdicts";

export type DocDiff = {
  docId: string;
  sha256: string;
  /** Spans present now but not in the baseline: FP candidates. */
  added: RunEntity[];
  /** Spans present in the baseline but gone now: FN candidates. */
  removed: RunEntity[];
};

export type DiffDocumentsOptions = {
  current: RunDocument;
  /** Null compares against nothing: every unjudged span is a candidate. */
  baseline: RunDocument | null;
  /** Span keys already covered by a verdict; never re-surfaced. */
  judged: ReadonlySet<string>;
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

  const added = current.entities.filter((entity) => {
    const key = spanKey(entity);
    return !baselineKeys.has(key) && !judged.has(key);
  });
  const removed = (baseline?.entities ?? []).filter((entity) => {
    const key = spanKey(entity);
    return !currentKeys.has(key) && !judged.has(key);
  });

  return { docId: current.docId, sha256: current.sha256, added, removed };
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

Reports unjudged span candidates in a run: FP candidates (spans the
baseline did not have, or all spans when no baseline is given) and FN
candidates (baseline spans that disappeared). Spans already covered by
a verdict file are excluded. JSON on stdout, summary on stderr.`;

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
      judged: judgedKeys(verdicts),
    });
    if (diff.added.length > 0 || diff.removed.length > 0) {
      diffs.push(diff);
    }
  }

  const addedTotal = diffs.reduce((sum, diff) => sum + diff.added.length, 0);
  const removedTotal = diffs.reduce(
    (sum, diff) => sum + diff.removed.length,
    0,
  );

  console.log(
    JSON.stringify(
      {
        run: values.run,
        baseline: values.baseline ?? null,
        documentsWithCandidates: diffs.length,
        fpCandidates: addedTotal,
        fnCandidates: removedTotal,
        docs: diffs,
      },
      null,
      2,
    ),
  );
  console.error(
    `${diffs.length} documents need triage: ${addedTotal} FP candidates, ${removedTotal} FN candidates (${judgedSpanCount} spans already judged)`,
  );
}
