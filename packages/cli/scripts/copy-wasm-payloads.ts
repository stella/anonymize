/* Copies the WASI payloads of the wasm search packages
 * into .wasm-payloads/ so src/compile.ts can embed them
 * into the standalone binary with `with { type: "file" }`.
 * Resolution follows the real dependency chain, so the
 * copied payloads always match the loader versions. */
import { copyFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const PAYLOAD_PACKAGES = [
  "@stll/aho-corasick-wasm",
  "@stll/fuzzy-search-wasm",
  "@stll/regex-set-wasm",
] as const;

const resolveDistDir = (spec: string, parentDir: string): string =>
  dirname(realpathSync(Bun.resolveSync(spec, parentDir)));

const cliDir = join(import.meta.dir, "..");
const payloadDir = join(cliDir, ".wasm-payloads");
mkdirSync(payloadDir, { recursive: true });

const anonymizeWasmDir = resolveDistDir("@stll/anonymize-wasm", cliDir);
const textSearchDir = resolveDistDir(
  "@stll/text-search-wasm",
  anonymizeWasmDir,
);

let copied = 0;
for (const pkg of PAYLOAD_PACKAGES) {
  const distDir = resolveDistDir(pkg, textSearchDir);
  const wasmFiles = readdirSync(distDir).filter((f) => f.endsWith(".wasm"));
  if (wasmFiles.length === 0) {
    throw new Error(`no .wasm payload found in ${distDir}`);
  }
  for (const file of wasmFiles) {
    copyFileSync(join(distDir, file), join(payloadDir, file));
    copied += 1;
  }
}

console.log(`copy-wasm-payloads: copied ${copied} payloads to .wasm-payloads/`);
