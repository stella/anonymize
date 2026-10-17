import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseJsonObject,
  parseNpmPack,
} from "../../../../.github/tools/json-values.mjs";
import { assertPackedRuntimeImports } from "../../../../.github/tools/packed-runtime-imports";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

test("npm pack contains the static runtime closure of every shipped entry script", () => {
  const manifest = parseJsonObject(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const packed = parseNpmPack(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  );
  const files = new Set(packed.files.map(({ path }) => path));
  const checked = assertPackedRuntimeImports({
    manifest,
    packedFiles: files,
    readSource: (path) => readFileSync(join(packageRoot, path), "utf8"),
  });
  expect(checked.size).toBeGreaterThan(0);
});
