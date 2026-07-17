#!/usr/bin/env bun
// A pull request that changes published runtime source must add a changeset or
// an explicit empty changeset. The generated version PR only changes release
// metadata, so it passes this source-scoped gate after consuming changesets.

import { $ } from "bun";
import { readFileSync } from "node:fs";

const BASE_REF = process.env.CHANGESET_BASE_REF ?? "origin/main";
const CHANGESET_RE = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const DATA_CHANGESET_RE = /^["']?@stll\/anonymize-data["']?:/m;
const RUNTIME_SOURCE_RE =
  /^(?:packages\/(?:anonymize|cli|document-docx)\/(?:src|scripts)\/|crates\/anonymize-(?:adapter-contract|core|napi|py)\/)/;
const RUNTIME_MANIFESTS = new Set([
  "Cargo.lock",
  "Cargo.toml",
  "packages/anonymize/package.json",
  "packages/anonymize-darwin-arm64/package.json",
  "packages/anonymize-darwin-x64/package.json",
  "packages/anonymize-linux-arm64-gnu/package.json",
  "packages/anonymize-linux-x64-gnu/package.json",
  "packages/anonymize-win32-x64-msvc/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
  "packages/document-docx/package.json",
]);

const firstSlash = BASE_REF.indexOf("/");
const baseRemote = firstSlash === -1 ? "origin" : BASE_REF.slice(0, firstSlash);
const baseBranch =
  firstSlash === -1 ? BASE_REF : BASE_REF.slice(firstSlash + 1);

await $`git fetch --no-tags ${baseRemote} ${baseBranch}`.nothrow().quiet();

const diff = async (filter: string): Promise<string[]> => {
  const result =
    await $`git diff --name-only --diff-filter=${filter} ${BASE_REF}...HEAD`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    console.error(
      `changeset check: git diff ${BASE_REF}...HEAD failed (exit ${result.exitCode}).`,
    );
    console.error(result.stderr.toString());
    process.exit(1);
  }
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const addedFiles = await diff("A");
const addedChangesets = addedFiles.filter((file) => CHANGESET_RE.test(file));
const dataChangeset = addedChangesets.find((file) =>
  DATA_CHANGESET_RE.test(readFileSync(file, "utf8")),
);
if (dataChangeset) {
  console.error(
    `${dataChangeset} selects @stll/anonymize-data, which has an independent release path.`,
  );
  process.exit(1);
}

const changedFiles = await diff("ACMRD");
const runtimeSourceChanged = changedFiles.some((file) =>
  RUNTIME_SOURCE_RE.test(file),
);
const runtimeManifestChanged = changedFiles.some((file) =>
  RUNTIME_MANIFESTS.has(file),
);
if (!runtimeSourceChanged && !runtimeManifestChanged) {
  console.log(
    "changeset check: no published runtime source changes; skipping.",
  );
  process.exit(0);
}

if (!runtimeSourceChanged && changedFiles.includes("VERSION")) {
  console.log(
    "changeset check: synchronized release metadata includes VERSION. OK.",
  );
  process.exit(0);
}

if (addedChangesets.length > 0) {
  console.log("changeset check: runtime source change has a changeset. OK.");
  process.exit(0);
}

console.error(
  [
    "Missing changeset.",
    "",
    "This pull request changes published runtime source but adds no changeset.",
    "Add one with:",
    "",
    "    bun run changeset",
    "",
    "If the change intentionally needs no release, record that explicitly:",
    "",
    "    bun run changeset --empty",
  ].join("\n"),
);
process.exit(1);
