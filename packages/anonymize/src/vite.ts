/* Vite plugin that wires up @stll/anonymize-wasm so its wasm binding and
 * prepared-package assets survive both Vite's dev pre-bundler and a production
 * `vite build`.
 *
 * The package loads its napi-rs binding and bundled `.stlanonpkg` packages at
 * runtime from its own `native/` asset directory via
 * `new URL("./native/…", import.meta.url)` (the wasm module, the WASI worker,
 * the glue, and the packages). The paths are computed at runtime, so neither
 * Vite's optimizer nor Rollup's static `new URL(…, import.meta.url)` handling
 * can follow them on their own.
 *
 * Dev (`vite serve`): the package plus the `@napi-rs/wasm-runtime` loader are
 * added to `optimizeDeps.exclude`, keeping their original on-disk paths so the
 * relative URLs resolve next to the package's own files.
 *
 * Build (`vite build`): Rollup bundles `wasm.mjs` into a chunk, rewriting
 * `import.meta.url`, and never copies the `native/` files. This plugin emits
 * every `native/*` file as a build asset under a stable `native/` subdir and
 * re-anchors the package's `assetUrl` base onto a Rollup file-URL reference, so
 * the runtime URLs resolve to the emitted assets from whatever chunk ends up
 * referencing them. The glue's own internal `new URL(…, import.meta.url)`
 * references (its `.wasm` and worker) keep working because the whole `native/`
 * directory is emitted verbatim, side by side.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Plugin } from "vite";

const PACKAGES = ["@stll/anonymize-wasm", "@napi-rs/wasm-runtime"];
const NATIVE_DIR = "native";
/** The Node glue is always shipped in `native/`; any file there works as the
 * anchor. `new URL(fileName, <anchor>)` resolves to `native/<fileName>` because
 * URL resolution replaces the anchor's last path segment. */
const ANCHOR_FILE = "index.wasi.cjs";
/** The exact `assetUrl` base expression emitted by the build (see wasm.ts).
 * Kept in sync with the compiled `wasm.mjs`; the transform fails loudly if the
 * dist shape drifts so this cannot silently ship broken asset paths. */
const ASSET_URL_BASE = "`./${NATIVE_ASSET_DIR}/${fileName}`, import.meta.url";

const isWasmEntry = (id: string): boolean =>
  id.includes("anonymize-wasm") && basename(id) === "wasm.mjs";

export default function stllAnonymizeWasmVite(): Plugin {
  let isBuild = false;
  return {
    name: "stll-anonymize-wasm",
    // optimizeDeps only affects dev; harmless (ignored) during build.
    config() {
      return { optimizeDeps: { exclude: PACKAGES } };
    },
    configResolved(resolved) {
      isBuild = resolved.command === "build";
    },
    async transform(code, id) {
      if (!(isBuild && isWasmEntry(id))) {
        return null;
      }
      if (!code.includes(ASSET_URL_BASE)) {
        this.error(
          `stll-anonymize-wasm: could not find the assetUrl base in ${id}. ` +
            "The @stll/anonymize-wasm dist shape changed; update ASSET_URL_BASE " +
            "in the Vite plugin.",
        );
      }
      const nativeDir = join(dirname(id), NATIVE_DIR);
      const files = await readdir(nativeDir);
      let anchorRef: string | undefined;
      for (const file of files) {
        const referenceId = this.emitFile({
          type: "asset",
          fileName: `${NATIVE_DIR}/${file}`,
          source: await readFile(join(nativeDir, file)),
        });
        if (file === ANCHOR_FILE) {
          anchorRef = referenceId;
        }
      }
      if (anchorRef === undefined) {
        this.error(
          `stll-anonymize-wasm: ${ANCHOR_FILE} is missing from ${nativeDir}; ` +
            "cannot anchor the native asset base.",
        );
      }
      return {
        code: code.replace(
          ASSET_URL_BASE,
          `fileName, import.meta.ROLLUP_FILE_URL_${anchorRef}`,
        ),
        map: null,
      };
    },
  };
}
