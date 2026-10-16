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
  expect(lint).toContain("-- bun run --filter @stll/anonymize-data typecheck");
  expect(lint).not.toContain("typecheck-proof.ts");
  expect(lint).toContain("bun run test:tooling");
  expect(lint).toContain("bun run lint");
  expect(lint).toContain("bun run format:check");
});
