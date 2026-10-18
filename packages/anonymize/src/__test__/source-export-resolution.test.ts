import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const packageUrl = new URL("../../", import.meta.url);

test("source type resolution works before build while runtime targets stay built", () => {
  for (const { conditions, target } of [
    {
      conditions: ["types", "@stll/anonymize-source"],
      target: "src/index.ts",
    },
    { conditions: ["types"], target: "dist/index.d.mts" },
    { conditions: ["@stll/anonymize-source"], target: "dist/index.mjs" },
    { conditions: [], target: "dist/index.mjs" },
  ]) {
    const result = spawnSync(
      "node",
      [
        ...conditions.map((condition) => `--conditions=${condition}`),
        "--input-type=module",
        "--eval",
        'process.stdout.write(import.meta.resolve("@stll/anonymize"));',
      ],
      { cwd: fileURLToPath(packageUrl), encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(new URL(target, packageUrl).href);
  }
});
