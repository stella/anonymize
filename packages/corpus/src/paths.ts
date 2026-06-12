import { join } from "node:path";

import { sha256Hex } from "./hash";
import type { CorpusSource } from "./types";

const packageRoot = join(import.meta.dir, "..");

export const CORPUS_DIR = join(packageRoot, "corpus");
export const MANIFEST_PATH = join(CORPUS_DIR, "manifest.json");
export const SKIPLIST_PATH = join(CORPUS_DIR, "skiplist.json");
export const RAW_DIR = join(CORPUS_DIR, "raw");
export const RUNS_DIR = join(CORPUS_DIR, "runs");
export const VERDICTS_DIR = join(CORPUS_DIR, "verdicts");

export const RUN_SUMMARY_FILE = "run.json";

const RUN_NAME_PATTERN = /^[\w.-]+$/;

/**
 * Run names flow into `join(RUNS_DIR, runName)` and `--force` removes that
 * directory tree, so a traversal name (`../x`, `..`) must never reach the
 * filesystem. Accept only word chars, `.` and `-`, and reject the bare
 * `.`/`..` path segments.
 */
export const isValidRunName = (runName: string): boolean =>
  RUN_NAME_PATTERN.test(runName) && runName !== "." && runName !== "..";

/** Validate a run name, printing a clear error and exiting 1 on violation. */
export const assertValidRunName = (runName: string): void => {
  if (isValidRunName(runName)) {
    return;
  }
  console.error(
    `invalid run name "${runName}": use only letters, digits, "_", "." and "-" (no path separators)`,
  );
  process.exit(1);
};

/**
 * Document ids contain `:`/`/`; map them to safe file names. Sanitizing alone
 * is lossy (`a:b` and `a_b` both collapse to `a_b`), so append a short
 * content-independent hash of the original id to keep distinct ids on distinct
 * files.
 */
export const rawFileName = (docId: string): string =>
  `${docId.replaceAll(/[^\w.-]/g, "_")}-${sha256Hex(docId).slice(0, 8)}.txt`;

export const rawPath = (docId: string): string =>
  join(RAW_DIR, rawFileName(docId));

/** Keep duplicate-content documents as distinct run artifacts. */
export const runArtifactFileName = (docId: string, sha256: string): string =>
  `${sha256}-${sha256Hex(docId).slice(0, 8)}.json`;

export const verdictsPath = (source: CorpusSource, sha256: string): string =>
  join(VERDICTS_DIR, source, `${sha256}.json`);
