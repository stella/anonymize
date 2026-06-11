#!/usr/bin/env node
/* Standalone-binary entry point — backs the CLI with the
 * WebAssembly engine and a gzipped dictionary blob, so
 * `bun build --compile` embeds everything without
 * platform-specific native modules or raw JSON bundles.
 * Run the `compile` script (not bare bun build); it
 * prepares .wasm-payloads/ and .embedded/ first. */
import ahoCorasickWasm from "../.wasm-payloads/aho-corasick.wasm32-wasi.wasm" with { type: "file" };
import fuzzySearchWasm from "../.wasm-payloads/fuzzy-search.wasm32-wasi.wasm" with { type: "file" };
import regexSetWasm from "../.wasm-payloads/regex-set.wasm32-wasi.wasm" with { type: "file" };

import * as anonymize from "@stll/anonymize-wasm";

import { loadEmbeddedDictionaries } from "./dictionaries-embedded";
import { runCli } from "./main";

// Referenced so the bundler keeps the payloads embedded.
void ahoCorasickWasm;
void fuzzySearchWasm;
void regexSetWasm;

await runCli({ api: anonymize, loadDictionaries: loadEmbeddedDictionaries });
