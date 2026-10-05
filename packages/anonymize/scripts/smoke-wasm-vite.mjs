#!/usr/bin/env node
/** Bundle the shipped browser entry, then boot it in a page and a module worker. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { build } from "vite";
import stllAnonymizeWasm from "../wasm/dist/vite.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const route = "/knowledge/x/";
const timeout = 30_000;
const contentTypes = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".wasm", "application/wasm"],
]);
const executablePath = [
  process.env.CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].find((path) => path && existsSync(path));
assert.ok(executablePath, "Set CHROME_BIN to a system Chrome/Chromium binary");

const root = await mkdtemp(join(packageRoot, ".vite-browser-smoke-"));
// Preserve the installed package name: the plugin identifies its browser entry
// by the anonymize-wasm path, just as it appears under node_modules.
await symlink(join(packageRoot, "wasm"), join(root, "anonymize-wasm"), "dir");
const boot = `
import { createPipeline } from '@stll/anonymize-wasm';
export const boot = async () => {
  const pipeline = await createPipeline({ language: 'en' });
  return pipeline.redactText('Contact alice@example.com.').redaction.redactedText;
};
`;
await writeFile(join(root, "boot.js"), boot);
await writeFile(
  join(root, "worker.js"),
  `import { boot } from './boot.js';
boot().then(text => self.postMessage({ text })).catch(error => {
  self.postMessage({ error: String(error) });
});`,
);
await writeFile(
  join(root, "main.js"),
  `import { boot } from './boot.js';
window.bootPage = boot;
window.bootWorker = () => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    worker.terminate();
    if (data.error) reject(new Error(data.error));
    else resolve(data.text);
  };
  worker.onerror = event => {
    worker.terminate();
    reject(new Error(event.message));
  };
});`,
);
await writeFile(
  join(root, "index.html"),
  '<!doctype html><script type="module" src="./main.js"></script>',
);

let browser;
try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  for (const base of [route, "./"]) {
    const outDir = join(root, "output");
    await build({
      configFile: false,
      root,
      base,
      logLevel: "warn",
      resolve: {
        preserveSymlinks: true,
        alias: {
          "@stll/anonymize-wasm": join(root, "anonymize-wasm/dist/wasm.mjs"),
        },
      },
      plugins: [stllAnonymizeWasm({ packages: ["en"] })],
      worker: {
        format: "es",
        plugins: () => [stllAnonymizeWasm({ packages: ["en"] })],
      },
      build: { outDir, emptyOutDir: true, minify: false },
    });
    const requests = [];
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      requests.push(pathname);
      const path = resolve(
        outDir,
        pathname.slice(route.length) || "index.html",
      );
      if (!pathname.startsWith(route) || !path.startsWith(outDir + sep)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const bytes = await readFile(path);
        response.setHeader(
          "Content-Type",
          contentTypes.get(extname(path)) ?? "application/octet-stream",
        );
        response.end(bytes);
      } catch (error) {
        if (error.code !== "ENOENT") {
          response.destroy(error);
          return;
        }
        response.writeHead(404).end();
      }
    });
    let page;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      page = await browser.newPage();
      page.setDefaultTimeout(timeout);
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("requestfailed", (request) => errors.push(request.url()));
      page.on("response", (response) => {
        if (
          response.status() >= 400 &&
          !response.url().endsWith("favicon.ico")
        ) {
          errors.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.goto(`http://127.0.0.1:${server.address().port}${route}`);
      await page.waitForFunction(() => typeof window.bootWorker === "function");
      for (const context of ["page", "worker"]) {
        requests.length = 0;
        const text = await page.evaluate(async (context) => {
          const boot = context === "page" ? window.bootPage : window.bootWorker;
          let timer;
          try {
            return await Promise.race([
              boot(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("engine boot timed out")),
                  25_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }, context);
        assert.equal(typeof text, "string");
        assert.ok(
          text.includes("Contact"),
          `${base} ${context}: retained text`,
        );
        assert.ok(
          !text.includes("alice@example.com"),
          `${base} ${context}: redaction`,
        );
        for (const asset of [
          "index.js",
          "index_bg.wasm",
          "native-pipeline.en.stlanonpkg",
        ]) {
          assert.ok(
            requests.includes(`${route}native/${asset}`),
            `${base} ${context}: fetched ${asset} under the nested route`,
          );
        }
        assert.deepEqual(errors, [], `${base} ${context}: browser errors`);
        process.stdout.write(
          `vite wasm smoke passed: base=${base} context=${context}\n`,
        );
      }
    } finally {
      await page?.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
