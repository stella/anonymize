import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GroundTruthDocument } from "../ground-truth";
import type {
  Adapter,
  AdapterOutcome,
  NativePrediction,
} from "../adapters/types";

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const MACOS_NATIVE_TEARDOWN_EXIT = 134;
const MACOS_NATIVE_TEARDOWN_ERROR = "mutex lock failed: Invalid argument";

type ShieldEntity = {
  readonly start?: unknown;
  readonly end?: unknown;
  readonly type?: unknown;
  readonly text?: unknown;
};

type ShieldResult = {
  readonly entities?: unknown;
};

const parseEntities = (
  value: unknown,
  text: string,
  documentId: string,
): NativePrediction[] => {
  const result = value as ShieldResult;
  if (!Array.isArray(result.entities)) {
    throw new Error(`PII-Shield returned malformed output for ${documentId}`);
  }
  return result.entities.map((item) => {
    const entity = item as ShieldEntity;
    if (
      typeof entity.start !== "number" ||
      typeof entity.end !== "number" ||
      typeof entity.type !== "string" ||
      typeof entity.text !== "string" ||
      !Number.isSafeInteger(entity.start) ||
      !Number.isSafeInteger(entity.end) ||
      entity.start < 0 ||
      entity.end <= entity.start ||
      entity.end > text.length ||
      text.slice(entity.start, entity.end) !== entity.text
    ) {
      throw new Error(`PII-Shield returned an invalid span for ${documentId}`);
    }
    return {
      start: entity.start,
      end: entity.end,
      label: entity.type,
      text: entity.text,
    };
  });
};

const command = (): string => process.env["PII_SHIELD_BIN"] ?? "pii-shield";

const runProcess = async (args: readonly string[]) => {
  const process = Bun.spawn([command(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: SCAN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export const createPiiShieldAdapter = (): Adapter => ({
  name: "pii-shield",
  version: "unknown",
  run: async (
    documents: readonly GroundTruthDocument[],
  ): Promise<AdapterOutcome> => {
    if (
      (command().includes("/") || command().includes("\\")) &&
      !existsSync(command())
    ) {
      return {
        status: "unavailable",
        reason: `PII_SHIELD_BIN does not exist: ${command()}`,
      };
    }
    let version: Awaited<ReturnType<typeof runProcess>>;
    try {
      version = await runProcess(["--version"]);
    } catch {
      return {
        status: "unavailable",
        reason:
          "pii-shield CLI is unavailable; install it and its GLiNER model, then set PII_SHIELD_BIN if needed",
      };
    }
    if (version.exitCode !== 0) {
      return {
        status: "unavailable",
        reason:
          "pii-shield CLI is unavailable; install it and its GLiNER model, then set PII_SHIELD_BIN if needed",
      };
    }

    const directory = await mkdtemp(join(tmpdir(), "stella-blind-pii-shield-"));
    const predictions = new Map<string, readonly NativePrediction[]>();
    const start = performance.now();
    try {
      for (const document of documents) {
        const input = join(directory, `${document.id}.txt`);
        await Bun.write(input, document.text);
        const scan = await runProcess([
          "scan",
          input,
          "--json",
          "--lang",
          document.language,
          "--wait-ner",
          "300",
        ]);
        let parsed: unknown;
        try {
          parsed = JSON.parse(scan.stdout);
        } catch {
          const tail = scan.stderr.trim().split("\n").slice(-3).join(" | ");
          throw new Error(
            `PII-Shield returned no valid JSON for ${document.id} (exit ${scan.exitCode}): ${tail}`,
          );
        }
        const toleratedMacosTeardown =
          process.platform === "darwin" &&
          scan.exitCode === MACOS_NATIVE_TEARDOWN_EXIT &&
          scan.stderr.includes(MACOS_NATIVE_TEARDOWN_ERROR);
        if (scan.exitCode !== 0 && !toleratedMacosTeardown) {
          const tail = scan.stderr.trim().split("\n").slice(-3).join(" | ");
          throw new Error(
            `PII-Shield scan failed for ${document.id} (exit ${scan.exitCode}): ${tail}`,
          );
        }
        predictions.set(
          document.id,
          parseEntities(parsed, document.text, document.id),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const elapsed = (performance.now() - start) / 1000;
    const totalChars = documents.reduce(
      (sum, document) => sum + document.text.length,
      0,
    );
    return {
      status: "ok",
      predictions,
      timing: {
        initSeconds: 0,
        coldSeconds: elapsed,
        warmSeconds: elapsed,
        totalChars,
      },
      reportedVersion: version.stdout.trim(),
      notes:
        "CLI scan --json; one isolated temporary text file per document; complete validated JSON accepted before PII-Shield 2.2.0 macOS native teardown exit 134",
    };
  },
});
