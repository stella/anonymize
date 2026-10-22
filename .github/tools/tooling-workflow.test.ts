import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../workflows/ci.yml", import.meta.url),
  "utf8",
);

test("uses committed history and shared detector to select workspace parity", () => {
  const lint = workflow.split("  static:\n").at(1)?.split("  tests:").at(0);
  expect(lint).toContain("fetch-depth: 0");
  expect(lint).toContain("persist-credentials: false");
  expect(lint).toContain('stll-toolchain-changed --since "$BASE_REF"');
  expect(lint).toContain(
    "github.event.pull_request.base.sha || github.event.before",
  );
  expect(lint).toContain("'unavailable-toolchain-base'");
  expect(lint).toContain("if: steps.toolchain.outputs.changed == 'true'");
  expect(lint).toContain("stll-typecheck-probe");
  expect(lint).toContain("--project packages/data/tsconfig.json");
  expect(lint).toContain("--seed-dir packages/data/dictionaries");
  expect(lint).toContain("-- bun run --cwd packages/data typecheck");
  expect(lint).not.toContain("typecheck-proof.ts");
  expect(lint).toContain("bun run test:tooling");
  expect(lint).toContain("bun run lint");
  expect(lint).toContain("bun fmt --check");
});

test("Rust caches retain artifacts while registry index metadata stays fresh", () => {
  const setup = readFileSync(
    new URL("../actions/setup-rust-ci/action.yml", import.meta.url),
    "utf8",
  );
  const paths = setup
    .split("        path: |\n")
    .at(1)
    ?.split("        key:")
    .at(0)
    ?.trim()
    .split("\n")
    .map((path) => path.trim());
  if (paths === undefined) throw new Error("Missing Rust cache paths");
  expect(paths).toContain("~/.cargo/registry/cache/");
  expect(paths).toContain("target/");
  for (const path of paths) {
    expect(path).not.toMatch(/^~\/\.cargo\/?$/u);
    if (path.startsWith("~/.cargo/registry")) {
      expect(path).toBe("~/.cargo/registry/cache/");
    }
  }
});

// Keep underlying project diagnostics visible when another static check fails.
test("typecheck still runs after a preceding static check fails", () => {
  expect(workflow).toContain(
    "- name: Typecheck\n        if: ${{ !cancelled() }}\n        run: bun run typecheck:built",
  );
});
