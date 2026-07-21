#!/usr/bin/env bun
// CI gate: catches stale workspace `"version"` fields cached in bun.lock.
//
// Why this exists: `bun install` (even non-frozen) does NOT rewrite the
// `"version"` field bun.lock records for an already-present workspace entry
// when only that package's own package.json version changed — it only
// re-resolves dependency ranges. `bun install --frozen-lockfile` (what CI
// runs everywhere) validates that the dependency graph still satisfies the
// lockfile; it does not compare workspace self-versions either. So neither
// the normal install path nor the frozen-lockfile CI gate ever notices a
// workspace's recorded version drifting behind its package.json — and
// pack/publish tooling reads the *lockfile's* cached version when resolving
// `workspace:*`/`workspace:^` ranges (see packages/benchmark and
// packages/corpus, which depend on `@stll/anonymize` via `workspace:^`), so
// a stale entry can silently ship a wrong dependency range.
//
// The only fix once it drifts is `rm bun.lock && bun install` (a full
// regenerate). This script cross-checks each workspace package.json
// `version` against the version bun.lock has cached for that workspace, so
// the drift itself gets caught in CI instead of silently persisting.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(path).text());

// Derive workspace directories from the root package.json `workspaces`
// globs instead of hardcoding a layout, so this script keeps working if the
// repo's workspace structure changes. Only two glob shapes are supported:
// a literal path (no wildcard) and a single trailing `/*` (one level of
// subdirectories) — that covers every pattern bun's own workspaces field
// supports in practice, and is enough for this repo's `packages/*` and
// `packages/anonymize/wasm` entries.
const resolveWorkspaceDirs = async (globs: string[]): Promise<string[]> => {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -"/*".length);
      const entries = await readdir(join(ROOT, parent), {
        withFileTypes: true,
      });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
      }
      continue;
    }
    if (glob.includes("*")) {
      throw new Error(
        `Unsupported workspaces glob '${glob}': only a literal path or a single trailing '/*' is supported`,
      );
    }
    dirs.push(glob);
  }
  return dirs;
};

const rootPkg = await readJson(join(ROOT, "package.json"));
const workspaceGlobs = rootPkg.workspaces;
if (!Array.isArray(workspaceGlobs)) {
  throw new Error("root package.json must declare a `workspaces` array");
}
const workspaceDirs = await resolveWorkspaceDirs(workspaceGlobs as string[]);

const lockText = await Bun.file(join(ROOT, "bun.lock")).text();

// bun.lock is JSON-with-trailing-commas ("JSONC"-flavored), not strict JSON,
// so a plain JSON.parse fails on it as-is. Trailing commas only ever appear
// directly before a closing `}`/`]`, and that exact sequence cannot occur
// inside any of bun.lock's own string values (workspace paths, package
// names/versions/specifiers, or the base64 `sha512-...` integrity hashes),
// so stripping them is a safe, structure-preserving normalize. Parsing the
// whole file once and reading `workspaces[dir].version` from the resulting
// object is immune to bun's key ordering or nested-object shape — unlike a
// per-block regex, there is no block to mis-extract.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsedLock: unknown = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1"));
if (!isRecord(parsedLock) || !isRecord(parsedLock.workspaces)) {
  throw new Error(
    "bun.lock did not parse into the expected { workspaces: {...} } shape",
  );
}
const { workspaces: lockWorkspaces } = parsedLock;

const versionForWorkspace = (workspacePath: string): string | null => {
  const entry = lockWorkspaces[workspacePath];
  if (!isRecord(entry) || typeof entry.version !== "string") return null;
  return entry.version;
};

const mismatches: string[] = [];

for (const workspaceDir of workspaceDirs) {
  const pkgPath = join(ROOT, workspaceDir, "package.json");
  // A directory matched by a workspace glob is not necessarily a real
  // workspace: skip it (rather than crash the guard) if its package.json
  // is missing or fails to parse.
  const pkg = await readJson(pkgPath).catch(() => null);
  if (pkg === null) continue;
  const name = pkg.name;
  const version = pkg.version;
  if (typeof name !== "string" || typeof version !== "string") continue;

  const lockedVersion = versionForWorkspace(workspaceDir);
  if (lockedVersion === null) {
    mismatches.push(`${name} (${workspaceDir}): no bun.lock entry found`);
    continue;
  }
  if (lockedVersion !== version) {
    mismatches.push(
      `${name} (${workspaceDir}): package.json is ${version}, bun.lock has ${lockedVersion}`,
    );
  }
}

if (mismatches.length > 0) {
  console.error(
    [
      "bun.lock workspace-version drift detected:",
      "",
      ...mismatches.map((line) => `  - ${line}`),
      "",
      "A plain `bun install` will not fix this (it doesn't rewrite cached",
      "workspace versions for entries that already exist). Regenerate the",
      "lockfile instead:",
      "",
      "    rm bun.lock && bun install",
      "",
      "Then commit the refreshed bun.lock.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  "bun.lock workspace-version check: all workspace versions match. OK.",
);
