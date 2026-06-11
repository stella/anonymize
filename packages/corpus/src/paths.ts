import { join } from "node:path";

import type { CorpusSource } from "./types";

const packageRoot = join(import.meta.dir, "..");

export const CORPUS_DIR = join(packageRoot, "corpus");
export const MANIFEST_PATH = join(CORPUS_DIR, "manifest.json");
export const RAW_DIR = join(CORPUS_DIR, "raw");
export const RUNS_DIR = join(CORPUS_DIR, "runs");
export const VERDICTS_DIR = join(CORPUS_DIR, "verdicts");

export const RUN_SUMMARY_FILE = "run.json";

/** Document ids contain `:`/`/`; map them to safe file names. */
export const rawFileName = (docId: string): string =>
  `${docId.replaceAll(/[^\w.-]/g, "_")}.txt`;

export const rawPath = (docId: string): string =>
  join(RAW_DIR, rawFileName(docId));

export const verdictsPath = (source: CorpusSource, sha256: string): string =>
  join(VERDICTS_DIR, source, `${sha256}.json`);
