import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  type PipelineConfig,
  preparePipelineSearch,
  runPipeline,
} from "@stll/anonymize";

import { loadCorpusDictionaries } from "./dictionaries";
import { sha256Hex } from "./hash";
import { loadManifest } from "./manifest";
import {
  assertValidRunName,
  runArtifactFileName,
  RUN_SUMMARY_FILE,
  RUNS_DIR,
  rawPath,
} from "./paths";
import type { RunDocument, RunEntity, RunSummary } from "./types";

const usage = `Usage: bun src/run.ts [--out <name>] [--force]

Runs the rules pipeline (NER off) over every manifest document and
writes per-document artifacts to corpus/runs/<name>/<sha256>-<id-hash>.json.
<name> defaults to the current git short SHA (plus "-dirty" when the
tree has uncommitted changes).`;

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    force: { type: "boolean" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.error(usage);
  process.exit(0);
}

const git = (args: string[]): string => {
  // Bun.spawnSync throws if the git binary is absent; fall back to "".
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};

const defaultRunName = (): string => {
  const sha = git(["rev-parse", "--short", "HEAD"]) || "no-git";
  const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
  return `${sha}${dirty}`;
};

const runName = values.out ?? defaultRunName();
assertValidRunName(runName);
const runDir = join(RUNS_DIR, runName);

if (existsSync(runDir) && !values.force) {
  console.error(`run "${runName}" already exists; use --force to overwrite`);
  process.exit(1);
}

const manifest = await loadManifest();
if (manifest.entries.length === 0) {
  console.error("manifest is empty; fetch documents first (src/fetch.ts)");
  process.exit(1);
}

const dictionaries = await loadCorpusDictionaries();

/** Canonical RULES configuration (matches scripts/contract-perf.mjs). */
const config: PipelineConfig = {
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
  workspaceId: "corpus-run",
  dictionaries,
};

const context = createPipelineContext();
await preparePipelineSearch({ config, context });

// Forcing reuses an existing run name; clear stale document
// artifacts so removed documents do not linger beside fresh output.
if (values.force) {
  rmSync(runDir, { recursive: true, force: true });
}
mkdirSync(runDir, { recursive: true });

let totalEntities = 0;

for (const entry of manifest.entries) {
  const file = Bun.file(rawPath(entry.id));
  if (!(await file.exists())) {
    console.error(`missing raw text for ${entry.id}; re-run fetch`);
    process.exit(1);
  }
  const fullText = await file.text();
  const actualSha = sha256Hex(fullText);
  if (actualSha !== entry.sha256) {
    console.error(
      `sha mismatch for ${entry.id}: manifest ${entry.sha256}, file ${actualSha}`,
    );
    process.exit(1);
  }

  const startedAt = performance.now();
  const detected = await runPipeline({
    fullText,
    config,
    gazetteerEntries: [],
    context,
  });
  const ms = Math.round(performance.now() - startedAt);

  const entities: RunEntity[] = detected
    .map(({ start, end, label, text, score, source }) => ({
      start,
      end,
      label,
      text,
      score,
      source,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const doc: RunDocument = {
    docId: entry.id,
    sha256: entry.sha256,
    language: entry.language,
    entityCount: entities.length,
    entities,
  };
  await Bun.write(
    join(runDir, runArtifactFileName(entry.id, entry.sha256)),
    `${JSON.stringify(doc, null, 2)}\n`,
  );
  totalEntities += entities.length;
  console.error(`${entry.id}: ${entities.length} entities (${ms}ms)`);
}

const summary: RunSummary = {
  createdAt: new Date().toISOString(),
  gitSha: git(["rev-parse", "HEAD"]) || "no-git",
  documentCount: manifest.entries.length,
  entityCount: totalEntities,
};
await Bun.write(
  join(runDir, RUN_SUMMARY_FILE),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.error(
  `run "${runName}": ${summary.documentCount} documents, ${summary.entityCount} entities`,
);
