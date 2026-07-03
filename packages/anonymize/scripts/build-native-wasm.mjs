#!/usr/bin/env node
/**
 * Build the napi-rs wasm32-wasip1-threads binding into `native-wasm-dist/`.
 *
 * Set STELLA_ANONYMIZE_SKIP_WASM_BUILD=1 to skip (the release pack-native
 * matrix only packs platform `.node` sidecars and does not need the wasm
 * binding; building it on every platform runner would be wasted work).
 */
import { execFileSync } from "node:child_process";

if (process.env.STELLA_ANONYMIZE_SKIP_WASM_BUILD === "1") {
  console.log(
    "build-native-wasm: skipped (STELLA_ANONYMIZE_SKIP_WASM_BUILD=1)",
  );
  process.exit(0);
}

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
