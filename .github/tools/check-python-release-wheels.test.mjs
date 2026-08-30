import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);
const byName = (left, right) => left.localeCompare(right);

const expectedContract = {
  "python-wheel-aarch64-apple-darwin": ["macosx_11_0_arm64"],
  "python-wheel-aarch64-unknown-linux-gnu": [
    "manylinux_2_17_aarch64",
    "manylinux2014_aarch64",
  ],
  "python-wheel-x86_64-apple-darwin": ["macosx_10_12_x86_64"],
  "python-wheel-x86_64-pc-windows-msvc": ["win_amd64"],
  "python-wheel-x86_64-unknown-linux-gnu": [
    "manylinux_2_17_x86_64",
    "manylinux2014_x86_64",
  ],
};

const assertCallerContract = (source) => {
  assert.match(
    source,
    /^        uses: stella\/\.github\/\.github\/actions\/pypi-publish-hardened@[0-9a-f]{40}$/m,
  );
  assert.match(
    source,
    /^        uses: pypa\/gh-action-pypi-publish@[0-9a-f]{40}/m,
  );
  assert.match(
    source,
    /^        uses: stella\/\.github\/\.github\/actions\/pypi-publish-hardened\/verify@[0-9a-f]{40}$/m,
  );
  assert.equal(
    source.match(
      /^          expected-version: \$\{\{ needs\.verify\.outputs\.version \}\}$/gm,
    )?.length,
    2,
  );
  assert.equal(
    source.match(/^          project-name: stella-anonymize-core$/gm)?.length,
    2,
  );
  assert.match(source, /^          distribution-name: stella_anonymize_core$/m);
  assert.match(source, /^          packages-dir: dist$/m);
  assert.match(source, /^          skip-existing: true$/m);

  const contract = source.match(
    /^          wheel-contract: >-\n            (\{.+\})$/m,
  );
  assert.ok(contract, "release workflow has no static wheel contract");
  assert.deepEqual(JSON.parse(contract[1]), expectedContract);

  const targets = [
    ...source.matchAll(/^          - target: ([a-z0-9_-]+)$/gm),
  ].map((match) => `python-wheel-${match[1]}`);
  assert.deepEqual(
    targets.toSorted(byName),
    Object.keys(expectedContract).toSorted(byName),
  );
};

void test("binds the shared publisher to the exact anonymize wheel set", () => {
  assertCallerContract(workflow);
});

void test("rejects caller identity and platform drift", () => {
  for (const mutation of [
    workflow.replace(
      "project-name: stella-anonymize-core",
      "project-name: other",
    ),
    workflow.replace("macosx_10_12_x86_64", "macosx_12_0_x86_64"),
    workflow.replace(
      '"python-wheel-x86_64-pc-windows-msvc":["win_amd64"]',
      '"python-wheel-x86_64-pc-windows-msvc":["win32"]',
    ),
  ]) {
    assert.notEqual(mutation, workflow);
    assert.throws(() => assertCallerContract(mutation));
  }
});
