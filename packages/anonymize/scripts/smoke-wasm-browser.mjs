#!/usr/bin/env node
/**
 * Headless-browser smoke test for the @stll/anonymize-wasm BROWSER path.
 *
 * The Node-WASI smokes (`smoke:wasm`, `smoke:wasm-package`) exercise the
 * `index.wasi.cjs` glue under `node:wasi`. They never touch the browser glue
 * (`index.wasi-browser.js`), its Web `Worker`, or the `SharedArrayBuffer` path
 * that the `wasm32-wasip1-threads` binding needs. This smoke closes that gap.
 *
 * Architecture:
 *   - A local static HTTP server serves the built `wasm/dist/` directory. Every
 *     response carries the cross-origin isolation headers the shared-memory
 *     (SharedArrayBuffer) path requires:
 *         Cross-Origin-Opener-Policy:   same-origin
 *         Cross-Origin-Embedder-Policy: require-corp
 *     so `self.crossOriginIsolated === true` in the served document, its module
 *     worker, and the wasm fetch. Serving isolated headers is why NO Chrome
 *     `--enable-features=SharedArrayBuffer` flag is needed: SAB is available to
 *     a properly isolated context by default on every supported channel.
 *   - A headless Chrome (system binary; see resolveChrome) navigates to the
 *     isolated document, then dynamically imports the package browser entry
 *     (`/wasm.mjs`) and runs `loadDefaultPipeline("en")` + `redactText`. The
 *     module's own `import.meta.url` resolves the `native/` glue, worker, wasm
 *     binary, and the `en` compressed package from the same origin.
 *
 * Assumptions / environment:
 *   - The package must be built first: `bun run build` then
 *     `bun run build:wasm-assets` (produces `wasm/dist/wasm.mjs` and
 *     `wasm/dist/native/`).
 *   - A system Chrome/Chromium is available. Locally that is the macOS app; on
 *     GitHub ubuntu runners it is `google-chrome-stable`. Set CHROME_BIN or
 *     PUPPETEER_EXECUTABLE_PATH to override. We use `puppeteer-core` (no bundled
 *     browser download) to keep CI light.
 *   - `--no-sandbox` is passed so the smoke runs as root on CI runners; the
 *     served content is local and trusted.
 *
 * Run: `node scripts/smoke-wasm-browser.mjs` (from packages/anonymize).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const distDir = join(packageRoot, "wasm", "dist");

const SAMPLE = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const EXTERNAL_DETECTION_DOCUMENT = "😀Alice signed.";
// Hard ceiling so a hung browser/worker cannot exceed the CI budget.
const OVERALL_TIMEOUT_MS = 90_000;
const EVAL_TIMEOUT_MS = 45_000;

const startedAt = Date.now();
const mark = (phase) =>
  process.stderr.write(`[smoke] ${phase} +${Date.now() - startedAt}ms\n`);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".stlanonpkg", "application/octet-stream"],
]);

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const INDEX_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<title>anonymize-wasm browser smoke</title></head><body></body></html>";

const requireBuilt = () => {
  const entry = join(distDir, "wasm.mjs");
  const enPackage = join(distDir, "native", "native-pipeline.en.stlanonpkg");
  for (const [label, path] of [
    ["package entry", entry],
    ["en compressed package", enPackage],
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        `Missing ${label}: ${path}. Run "bun run build" then "bun run build:wasm-assets".`,
      );
    }
  }
};

/** Locate a system Chrome/Chromium. Prefers explicit env overrides, then the
 * well-known macOS and Linux install paths. */
const resolveChrome = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No system Chrome/Chromium found. Set CHROME_BIN or " +
      "PUPPETEER_EXECUTABLE_PATH to a Chrome binary.",
  );
};

/** Static file server for `wasm/dist/`, isolation headers on every response. */
const startServer = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
        response.setHeader(name, value);
      }
      const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (urlPath === "/") {
        response.setHeader("Content-Type", CONTENT_TYPES.get(".html"));
        response.end(INDEX_HTML);
        return;
      }
      // Resolve inside distDir and reject traversal outside it. The trailing
      // separator prevents prefix bypass via sibling dirs (e.g. dist-other).
      const filePath = normalize(join(distDir, urlPath));
      if (!filePath.startsWith(distDir + sep) || !existsSync(filePath)) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const type =
        CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream";
      response.setHeader("Content-Type", type);
      response.end(readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/** Runs inside the isolated page: prove SAB is available, load the browser
 * entry, redact, and hand a compact result back to Node. */
const runInPage = async (sample, externalDetectionDocument) => {
  if (self.crossOriginIsolated !== true) {
    throw new Error("document is not cross-origin isolated");
  }
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer is unavailable");
  }
  const module = await import("/wasm.mjs");
  const externalDocument = new TextEncoder().encode(externalDetectionDocument);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", externalDocument)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const externalBatch = (offsetUnit, start, end) => ({
    version: module.EXTERNAL_DETECTION_BATCH_VERSION,
    document: { sha256: digest },
    offsetUnit,
    provider: {
      id: "browser-fake-provider",
      name: "Browser fake provider",
      version: "1",
    },
    labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
    detections: [{ id: "person-1", start, end, label: "PER", score: 0.99 }],
  });
  const externalDetectionResults = [];
  for (const [offsetUnit, start, end] of [
    ["utf8-byte", 4, 9],
    ["utf16-code-unit", 2, 7],
    ["unicode-code-point", 1, 6],
  ]) {
    externalDetectionResults.push(
      await module.convert_external_detection_batch(
        externalDocument,
        externalBatch(offsetUnit, start, end),
      ),
    );
  }
  const rejectionCases = [
    externalBatch("utf8-byte", 1, 9),
    externalBatch("utf16-code-unit", 1, 7),
    {
      ...externalBatch("unicode-code-point", 1, 6),
      document: { sha256: "0".repeat(64) },
    },
    JSON.stringify({
      ...externalBatch("unicode-code-point", 1, 6),
      legacyOffsetGuessing: true,
    }),
  ];
  const externalDetectionRejections = [];
  for (const batch of rejectionCases) {
    try {
      await module.convert_external_detection_batch(externalDocument, batch);
      externalDetectionRejections.push(false);
    } catch {
      externalDetectionRejections.push(true);
    }
  }
  const pipeline = await module.loadDefaultPipeline("en");
  const result = pipeline.redactText(sample);
  const session = pipeline.createRedactionSession("browser_archive_smoke_1");
  session.redactText(sample);
  const key = new Uint8Array(32).fill(0x42);
  const archive = session.toEncryptedArchive(key);
  const restoredSession = pipeline.restoreEncryptedRedactionSession({
    archive,
    key,
    expectedSessionId: "browser_archive_smoke_1",
  });
  return {
    entities: result.resolvedEntities.map(({ start, end, text, label }) => ({
      start,
      end,
      text,
      label,
    })),
    redactedText: result.redaction.redactedText,
    archiveByteLength: archive.byteLength,
    restoredSessionId: restoredSession.sessionId(),
    restoredMappingCount: restoredSession.mappingCount(),
    externalDetectionResults,
    externalDetectionRejections,
  };
};

const validate = (result) => {
  const {
    entities,
    redactedText,
    archiveByteLength,
    restoredSessionId,
    restoredMappingCount,
    externalDetectionResults,
    externalDetectionRejections,
  } = result;
  const expectedExternalDetection = [
    {
      start: 2,
      end: 7,
      label: "person",
      score: 0.99,
      providerId: "browser-fake-provider",
      detectionId: "person-1",
    },
  ];
  if (
    externalDetectionResults.length !== 3 ||
    externalDetectionResults.some(
      (detections) =>
        JSON.stringify(detections) !==
        JSON.stringify(expectedExternalDetection),
    )
  ) {
    throw new Error("browser external detection offset conversion diverged");
  }
  if (
    externalDetectionRejections.length !== 4 ||
    externalDetectionRejections.some((rejected) => !rejected)
  ) {
    throw new Error("browser external detection contract did not fail closed");
  }
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error("browser pipeline did not detect any entity");
  }
  for (const { start, end, text, label } of entities) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > SAMPLE.length ||
      // Offsets are UTF-16 code units, so a JS slice must round-trip the text.
      SAMPLE.slice(start, end) !== text
    ) {
      throw new Error(
        `entity offsets do not round-trip: ${label} [${start}, ${end}) => ` +
          `"${SAMPLE.slice(start, end)}" != "${text}"`,
      );
    }
  }
  if (redactedText === SAMPLE) {
    throw new Error("redaction did not change the text");
  }
  if (
    archiveByteLength <= 0 ||
    restoredSessionId !== "browser_archive_smoke_1" ||
    restoredMappingCount <= 0
  ) {
    throw new Error("browser encrypted session archive did not round-trip");
  }
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);

const main = async () => {
  requireBuilt();
  const executablePath = resolveChrome();
  const server = await startServer();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  mark("server-listening");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  mark("browser-launched");

  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(origin, { waitUntil: "load", timeout: EVAL_TIMEOUT_MS });
    mark("page-loaded");
    const result = await withTimeout(
      page.evaluate(runInPage, SAMPLE, EXTERNAL_DETECTION_DOCUMENT),
      EVAL_TIMEOUT_MS,
      "page redaction",
    );
    mark("redaction-done");
    validate(result);

    console.log(
      JSON.stringify({
        event: "wasm-browser-smoke",
        ok: true,
        chrome: executablePath,
        crossOriginIsolated: true,
        entityCount: result.entities.length,
        encryptedSessionArchive: true,
        labels: result.entities.map((entity) => entity.label),
        firstEntity: {
          start: result.entities[0].start,
          end: result.entities[0].end,
          label: result.entities[0].label,
        },
      }),
    );
  } catch (error) {
    if (consoleErrors.length > 0) {
      console.error("browser console errors:\n  " + consoleErrors.join("\n  "));
    }
    throw error;
  } finally {
    // The wasm binding's SharedArrayBuffer worker blocks on Atomics.wait, so a
    // graceful `browser.close()` can hang waiting for the thread to unwind.
    // Bound it and SIGKILL the browser process if it does not exit promptly.
    mark("closing");
    const process_ = browser.process();
    await withTimeout(browser.close(), 5_000, "browser close").catch(() => {
      process_?.kill("SIGKILL");
    });
    server.close();
    mark("closed");
  }
};

await withTimeout(main(), OVERALL_TIMEOUT_MS, "browser smoke")
  // A force-killed browser can leave puppeteer transport handles open, keeping
  // the event loop alive. Exit explicitly once the assertions have passed.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
