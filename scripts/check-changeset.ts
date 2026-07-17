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
  /^(?:packages\/(?:anonymize|cli|document-docx)\/(?:src|scripts)\/|crates\/anonymize-(?:adapter-contract|core|napi|py)\/|Cargo\.toml$)/;

await $`git fetch --no-tags origin ${BASE_REF.replace(/^origin\//, "")}`
  .nothrow()
  .quiet();

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

const runtimeSourceChanged = (await diff("ACMRD")).some((file) =>
  RUNTIME_SOURCE_RE.test(file),
);
if (!runtimeSourceChanged) {
  console.log(
    "changeset check: no published runtime source changes; skipping.",
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
