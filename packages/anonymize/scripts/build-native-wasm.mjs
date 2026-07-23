#!/usr/bin/env node
/**
 * Build the napi-rs wasm32-wasip1-threads binding into `native-wasm-dist/`.
 *
 * Set STELLA_ANONYMIZE_SKIP_WASM_BUILD=1 to skip (the release pack-native
 * matrix only packs platform `.node` sidecars and does not need the wasm
 * binding; building it on every platform runner would be wasted work).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { patchWasiLoadersForBun } from "./patch-wasm-loader-runtime.mjs";

if (process.env.STELLA_ANONYMIZE_SKIP_WASM_BUILD === "1") {
  console.log(
    "build-native-wasm: skipped (STELLA_ANONYMIZE_SKIP_WASM_BUILD=1)",
  );
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeDistDir = join(packageRoot, "native-wasm-dist");

execFileSync(
  "napi",
  [
    "build",
    "--manifest-path",
    "../../crates/anonymize-napi/Cargo.toml",
    "--config-path",
    "../../crates/anonymize-napi/napi.json",
    "--platform",
    "--target",
    "wasm32-wasip1-threads",
    "--no-default-features",
    "--release",
    "--output-dir",
    "native-wasm-dist",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

// napi-rs generates the Node WASI glue against `node:wasi`, whose `WASI` lacks
// `.initialize()` under Bun; patch it to the portable `@napi-rs/wasm-runtime`
// WASI so the binding loads under both runtimes. The Bun leg of
// `smoke-wasm-runtimes.mjs` guards against this regressing.
const patched = patchWasiLoadersForBun(nativeDistDir);
console.log(
  `build-native-wasm: patched WASI glue for Bun (${patched.join(", ")})`,
);
