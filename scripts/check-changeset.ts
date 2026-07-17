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
  /^(?:packages\/(?:anonymize|cli|document-docx)\/(?:(?:src|scripts)\/|(?:index\.cjs|tsconfig(?:\.wasm)?\.json|tsdown\.config\.ts)$)|crates\/anonymize-(?:adapter-contract|core|napi|py)\/)/;
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
const GENERATED_VERSION_METADATA = new Set([
  ...RUNTIME_MANIFESTS,
  "VERSION",
  "bun.lock",
  "crates/anonymize-py/pyproject.toml",
]);
const RUNTIME_CHANGELOG_RE =
  /^packages\/(?:anonymize(?:-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-gnu|win32-x64-msvc))?|cli|document-docx)(?:\/wasm)?\/CHANGELOG\.md$/;

const firstSlash = BASE_REF.indexOf("/");
const baseRemote = firstSlash === -1 ? "origin" : BASE_REF.slice(0, firstSlash);
const baseBranch =
  firstSlash === -1 ? BASE_REF : BASE_REF.slice(firstSlash + 1);
const expectedVersionBranch = `changeset-release/${baseBranch}`;
const headRef = process.env.CHANGESET_HEAD_REF ?? "";
const repository = process.env.CHANGESET_REPOSITORY ?? "";
const headRepository = process.env.CHANGESET_HEAD_REPOSITORY ?? "";
const prAuthor = process.env.CHANGESET_PR_AUTHOR ?? "";
const VERSION_PR_AUTHOR = "stella-provenance-updater[bot]";

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

const generatedVersionMetadataOnly = changedFiles.every(
  (file) =>
    GENERATED_VERSION_METADATA.has(file) ||
    RUNTIME_CHANGELOG_RE.test(file) ||
    CHANGESET_RE.test(file),
);
if (
  !runtimeSourceChanged &&
  headRef === expectedVersionBranch &&
  headRepository === repository &&
  prAuthor === VERSION_PR_AUTHOR &&
  changedFiles.includes("VERSION") &&
  generatedVersionMetadataOnly
) {
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
