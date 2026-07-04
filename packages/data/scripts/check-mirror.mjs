/**
 * Verify the anonymize package's runtime data subset stays in sync with the
 * canonical config tree.
 *
 * `packages/data/config/` is the single canonical source: the Rust core build
 * (`crates/anonymize-core/build.rs`) embeds it, and the assembler consumes it.
 * The TypeScript runtime no longer builds detector config in-process, so
 * `packages/anonymize/src/data/` now holds only the small subset the runtime
 * still imports directly (e.g. `language-scopes.json`, read by
 * `src/language-scope.ts`).
 *
 * This check enforces that every JSON file remaining in the runtime subset is
 * byte-identical to its counterpart in the canonical config tree, so the one
 * table both the TypeScript runtime and the Rust assembler read cannot drift.
 * The canonical tree is allowed to hold additional files the runtime does not
 * import.
 *
 * Exits non-zero with a per-file report when a runtime file is absent from the
 * canonical tree or differs in content.
 *
 * Run via `bun run --cwd packages/data check:mirror` or from CI.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CANONICAL_DIR = join(REPO_ROOT, "packages", "data", "config");
const RUNTIME_SUBSET_DIR = join(
  REPO_ROOT,
  "packages",
  "anonymize",
  "src",
  "data",
);

const listJsonFiles = (dir) => {
  const entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  entries.sort();
  return entries;
};

const hashFile = (path) => {
  const hasher = createHash("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
};

const main = () => {
  const canonicalStat = statSync(CANONICAL_DIR, { throwIfNoEntry: false });
  if (!canonicalStat || !canonicalStat.isDirectory()) {
    console.error(
      `check:mirror: expected canonical config directory at ${CANONICAL_DIR}`,
    );
    process.exit(1);
  }
  const canonicalFiles = listJsonFiles(CANONICAL_DIR);
  if (canonicalFiles.length === 0) {
    console.error(`check:mirror: canonical config tree is empty`);
    process.exit(1);
  }
  const canonicalSet = new Set(canonicalFiles);

  const runtimeStat = statSync(RUNTIME_SUBSET_DIR, { throwIfNoEntry: false });
  const runtimeFiles =
    runtimeStat && runtimeStat.isDirectory()
      ? listJsonFiles(RUNTIME_SUBSET_DIR)
      : [];

  const missing = runtimeFiles.filter((name) => !canonicalSet.has(name));
  const differing = runtimeFiles
    .filter((name) => canonicalSet.has(name))
    .filter(
      (name) =>
        hashFile(join(RUNTIME_SUBSET_DIR, name)) !==
        hashFile(join(CANONICAL_DIR, name)),
    );

  const problems = missing.length + differing.length;
  if (problems === 0) {
    console.log(
      `check:mirror: ${runtimeFiles.length} runtime JSON file(s) match the canonical config tree.`,
    );
    return;
  }

  console.error(
    "check:mirror: drift detected between the runtime data subset and the canonical config tree.",
  );
  console.error(`  runtime subset: ${RUNTIME_SUBSET_DIR}`);
  console.error(`  canonical:      ${CANONICAL_DIR}`);
  for (const name of missing) {
    console.error(`  missing from canonical config: ${name}`);
  }
  for (const name of differing) {
    console.error(`  content differs from canonical config: ${name}`);
  }
  process.exit(1);
};

main();
