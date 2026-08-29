import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);

const jobsStart = workflow.indexOf("\njobs:\n");
assert.notEqual(jobsStart, -1, "release workflow has no jobs section");
const jobsText = workflow.slice(jobsStart + "\njobs:\n".length);
const headers = [...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
const jobs = new Map(
  headers.map((header, index) => [
    header[1],
    jobsText.slice(header.index, headers[index + 1]?.index ?? jobsText.length),
  ]),
);

const job = (name) => {
  const body = jobs.get(name);
  assert.ok(body, `release workflow is missing ${name}`);
  return body;
};

void test("runtime artifacts are built and packed without OIDC", () => {
  for (const name of ["pack-native", "pack-runtime"]) {
    const body = job(name);
    assert.doesNotMatch(body, /id-token:\s*write/);
    assert.match(body, /npm pack --json --ignore-scripts/);
  }
});

void test("local OIDC publishers only consume release artifacts", () => {
  const forbidden =
    /actions\/checkout@|setup-bun@|bun (?:install|run)|npm pack|cargo |maturin-action@/;
  for (const [name, body] of jobs) {
    if (!/id-token:\s*write/.test(body) || /^    uses:/m.test(body)) {
      continue;
    }
    assert.doesNotMatch(body, forbidden, `${name} crosses the OIDC boundary`);
    assert.match(
      body,
      /actions\/download-artifact@/,
      `${name} does not consume an artifact`,
    );
  }
});

void test("data publishing validates the exact tarball before trusted publishing", () => {
  const body = job("publish-data");
  assert.match(body, /sha256sum --check/);
  assert.match(body, /npm-publish-hardened@/);
  assert.match(body, /npm install --global --ignore-scripts/);
});

void test("the fixed runtime group uses the pinned shared finalizer", () => {
  const body = job("github-release");
  assert.match(
    body,
    /npm-version-finalize\.yml@1ce0079bbdbf93a4c1917d2857496b89aedcec14/,
  );
  assert.match(
    body,
    /needs: \[verify, pack-native, pack-runtime, publish-pypi\]/,
  );
  assert.match(body, /artifact-pattern: npm-tarball-\*/);
  assert.doesNotMatch(body, /secrets:\s*inherit/);
  assert.doesNotMatch(body, /pull-requests:\s*write/);

  const packageFiles = [
    ...body.matchAll(/^        (packages\/.+\/package\.json)$/gm),
  ].map((match) => match[1]);
  const configuredPackages = JSON.parse(
    readFileSync(
      new URL("../../.changeset/config.json", import.meta.url),
      "utf8",
    ),
  ).fixed.at(0);
  const finalizedPackages = packageFiles.map(
    (packageFile) =>
      JSON.parse(
        readFileSync(new URL(`../../${packageFile}`, import.meta.url), "utf8"),
      ).name,
  );
  const byName = (left, right) => left.localeCompare(right);
  assert.deepEqual(
    finalizedPackages.toSorted(byName),
    configuredPackages.toSorted(byName),
  );

  const packedDirectories = [
    ...job("pack-native").matchAll(/^          - package: (packages\/.+)$/gm),
    ...job("pack-runtime").matchAll(/^          - (packages\/.+)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    packedDirectories
      .map((directory) => `${directory}/package.json`)
      .toSorted(byName),
    packageFiles.toSorted(byName),
  );
});
