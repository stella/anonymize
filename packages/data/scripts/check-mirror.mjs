/**
 * Verify packages/data/config/ is byte-identical to the
 * runtime tree at packages/anonymize/src/data/.
 *
 * The runtime tree is canonical (it powers the live
 * pipeline); this package is the public mirror. Drift
 * means consumers pulling the data package directly
 * would see different content than the runtime uses.
 *
 * Exits non-zero with a per-file report when any file
 * is missing, extra, or differs in content.
 *
 * Run via `bun run --cwd packages/data check:mirror`
 * or from CI.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const RUNTIME_DIR = join(REPO_ROOT, "packages", "anonymize", "src", "data");
const MIRROR_DIR = join(REPO_ROOT, "packages", "data", "config");

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
  for (const dir of [RUNTIME_DIR, MIRROR_DIR]) {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      console.error(`check:mirror: expected directory at ${dir}`);
      process.exit(1);
    }
  }

  const runtimeFiles = listJsonFiles(RUNTIME_DIR);
  const mirrorFiles = listJsonFiles(MIRROR_DIR);

  const runtimeSet = new Set(runtimeFiles);
  const mirrorSet = new Set(mirrorFiles);

  const missing = runtimeFiles.filter((name) => !mirrorSet.has(name));
  const extra = mirrorFiles.filter((name) => !runtimeSet.has(name));

  const shared = runtimeFiles.filter((name) => mirrorSet.has(name));
  const differing = shared.filter(
    (name) =>
      hashFile(join(RUNTIME_DIR, name)) !== hashFile(join(MIRROR_DIR, name)),
  );

  const problems = missing.length + extra.length + differing.length;
  if (problems === 0) {
    console.log(`check:mirror: ${shared.length} JSON files in sync.`);
    return;
  }

  console.error("check:mirror: drift detected between runtime and mirror.");
  console.error(`  runtime: ${RUNTIME_DIR}`);
  console.error(`  mirror:  ${MIRROR_DIR}`);
  for (const name of missing) {
    console.error(`  missing from mirror: ${name}`);
  }
  for (const name of extra) {
    console.error(`  unexpected in mirror: ${name}`);
  }
  for (const name of differing) {
    console.error(`  content differs: ${name}`);
  }
  process.exit(1);
};

main();
