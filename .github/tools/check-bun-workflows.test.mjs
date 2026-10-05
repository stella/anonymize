import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bunCacheProblems,
  bunPinProblems,
  bunWorkflowFiles,
} from "./check-bun-workflows.mjs";

const raw = {
  uses: "oven-sh/setup-bun@fixture",
  with: { "bun-version-file": "package.json" },
};
const cached = {
  ...raw,
  uses: "stella/.github/actions/setup-bun-cached@fixture",
};
const noCache = { ...raw, with: { ...raw.with, "no-cache": true } };
const workflow = (steps) => ({ jobs: { fixture: { steps } } });

void test("ordinary setup uses the cache owner and explicit no-cache remains raw", () => {
  assert.equal(bunCacheProblems(workflow([raw])).length, 1);
  assert.deepEqual(bunCacheProblems(workflow([cached])), []);
  assert.deepEqual(bunCacheProblems(workflow([noCache])), []);
  assert.equal(
    bunCacheProblems(workflow([{ ...cached, with: noCache.with }])).length,
    1,
  );
  for (const uses of [
    cached.uses,
    "actions/cache@fixture",
    "actions/cache/restore@fixture",
    "actions/cache/save@fixture",
  ]) {
    assert.equal(
      bunCacheProblems(workflow([noCache, { ...cached, uses }])).length,
      1,
    );
  }
});

void test("one no-cache declaration does not authorize other raw setups or exempt another job", () => {
  assert.equal(bunCacheProblems(workflow([noCache, raw])).length, 1);
  assert.equal(
    bunCacheProblems({
      jobs: { protected: { steps: [noCache] }, ordinary: { steps: [raw] } },
    }).length,
    1,
  );
  assert.deepEqual(
    bunCacheProblems({
      jobs: { protected: { steps: [noCache] }, ordinary: { steps: [cached] } },
    }),
    [],
  );
});

void test("both setup implementations retain the runtime pin contract", () => {
  for (const setup of [noCache, cached]) {
    for (const versionFile of [undefined, "other.json"]) {
      const findings = bunCacheProblems(
        workflow([
          {
            ...setup,
            with: { ...setup.with, "bun-version-file": versionFile },
          },
        ]),
      );
      assert.equal(findings.length, 1);
      assert.match(findings[0], /must use bun-version-file/);
    }
  }
});

void test("Turbo cache servers require an available string port", () => {
  const uses = "rharkor/caching-for-turbo@fixture";
  for (const port of [undefined, "41230", 0]) {
    assert.equal(
      bunCacheProblems(workflow([{ uses, with: { "server-port": port } }]))
        .length,
      1,
    );
  }
  assert.deepEqual(
    bunCacheProblems(workflow([{ uses, with: { "server-port": "0" } }])),
    [],
  );
});

void test("the pre-runtime pin check cannot borrow an input from a later conditional or run step", () => {
  for (const uses of [raw.uses, cached.uses]) {
    const valid = `steps:\n  - uses: ${uses}\n    with:\n      bun-version-file: package.json\n`;
    assert.deepEqual(bunPinProblems(valid), []);
    for (const next of [
      "if: success()",
      "run: echo ready",
      "name: Next setup",
    ]) {
      const nextSetup = next.startsWith("run:")
        ? `${next}\n  - uses: ${cached.uses}`
        : `${next}\n    uses: ${cached.uses}`;
      const invalid = `steps:\n  - uses: ${uses}\n  - ${nextSetup}\n    with:\n      bun-version-file: package.json\n`;
      assert.equal(bunPinProblems(invalid).length, 1);
    }
  }
  assert.equal(bunPinProblems("env:\n  BUN_VERSION: 1.4.2\n").length, 1);
  assert.equal(bunPinProblems("with:\n  bun-version: 1.4.2\n").length, 1);
  assert.deepEqual(bunPinProblems("# bun-version: 1.4.2\n"), []);
});

void test("the census includes every workflow and nested composite action without a filename list", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-workflow-census-"));
  try {
    for (const path of [".github/workflows", ".github/actions/nested/deeper"])
      mkdirSync(join(root, path), { recursive: true });
    const files = [
      ".github/workflows/first.yml",
      ".github/workflows/second.yaml",
      ".github/actions/nested/action.yaml",
      ".github/actions/nested/deeper/action.yml",
    ];
    for (const file of [
      ...files,
      ".github/workflows/README.md",
      ".github/actions/nested/README.md",
    ])
      writeFileSync(join(root, file), "fixture");
    assert.deepEqual(
      bunWorkflowFiles(root),
      files.map((file) => join(root, file)).toSorted(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("malformed job structure is a finding rather than an empty census", () => {
  for (const value of [
    null,
    {},
    { jobs: { fixture: null } },
    { jobs: { fixture: { steps: [null] } } },
  ]) {
    assert.equal(bunCacheProblems(value).length, 1);
  }
  assert.deepEqual(
    bunCacheProblems({
      jobs: { reusable: { uses: "./.github/workflows/reusable.yml" } },
    }),
    [],
  );
});
