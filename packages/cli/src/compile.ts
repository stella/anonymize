#!/usr/bin/env node
/* Standalone-binary entry point — backs the CLI with the
 * WebAssembly engine so `bun build --compile` can embed
 * everything without platform-specific native modules.
 * Run scripts/copy-wasm-payloads.ts first (the `compile`
 * script does); the wasi loaders read these payloads from
 * the binary's virtual filesystem by basename. */
import ahoCorasickWasm from "../.wasm-payloads/aho-corasick.wasm32-wasi.wasm" with { type: "file" };
import fuzzySearchWasm from "../.wasm-payloads/fuzzy-search.wasm32-wasi.wasm" with { type: "file" };
import regexSetWasm from "../.wasm-payloads/regex-set.wasm32-wasi.wasm" with { type: "file" };

import * as anonymize from "@stll/anonymize-wasm";

import { runCli } from "./main";

// Referenced so the bundler keeps the payloads embedded.
void ahoCorasickWasm;
void fuzzySearchWasm;
void regexSetWasm;

await runCli(anonymize);
