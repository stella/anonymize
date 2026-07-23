#!/usr/bin/env node
/**
 * Runtime-matrix guard for the WebAssembly binding.
 *
 * The wasm binding ships a single Node/Bun WASI loader, but the glue napi-rs
 * generates only works out of the box under Node (its `node:wasi` WASI has
 * `.initialize()`; Bun's does not). `patch-wasm-loader-runtime.mjs` rewrites the
 * glue to the portable `@napi-rs/wasm-runtime` WASI so it loads under both. This
 * runner makes "loads and runs under every supported non-browser runtime" an
 * enforced invariant: it executes each wasm smoke under Node AND Bun and fails
 * if any runtime/smoke pair fails. A future loader change that breaks a runtime
 * is then a red CI check, not a downstream surprise.
 *
 * The browser loader is covered separately by `smoke-wasm-browser.mjs`
 * (puppeteer); it is not a non-browser runtime and is intentionally excluded.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const RUNTIMES = ["node", "bun"];
const SMOKES = ["smoke-wasm.mjs", "smoke-wasm-package.mjs"];

const failures = [];
for (const smoke of SMOKES) {
  for (const runtime of RUNTIMES) {
    const label = `${runtime} ${smoke}`;
    const result = spawnSync(runtime, [join(scriptsDir, smoke)], {
      stdio: "inherit",
    });
    if (result.error) {
      failures.push(`${label}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      failures.push(`${label}: exited with status ${result.status}`);
    }
  }
}

if (failures.length > 0) {
  console.error(
    `smoke-wasm-runtimes: ${failures.length} failure(s):\n  ${failures.join("\n  ")}`,
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    event: "smoke-wasm-runtimes",
    ok: true,
    runtimes: RUNTIMES,
    smokes: SMOKES,
  }),
);
