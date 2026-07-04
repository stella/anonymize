import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GroundTruthDocument } from "../ground-truth";
import type { Adapter, AdapterOutcome, NativePrediction } from "./types";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

type PythonResult = {
  version: string;
  activeDetectors?: string[];
  initSeconds: number;
  coldSeconds: number;
  warmSeconds: number;
  totalChars: number;
  results: { id: string; entities: NativePrediction[] }[];
};

type PythonAdapterOptions = {
  readonly name: string;
  /** Virtualenv directory under the package root (created via REPRODUCING.md). */
  readonly venvDir: string;
  /** Adapter script under python/. */
  readonly script: string;
};

/**
 * Adapter backed by a Python virtualenv. If the venv or its interpreter is
 * missing, the adapter reports `unavailable` with the exact command to create
 * it, rather than failing the whole run.
 */
export const createPythonAdapter = ({
  name,
  venvDir,
  script,
}: PythonAdapterOptions): Adapter => {
  const pythonBin = join(PACKAGE_ROOT, venvDir, "bin", "python");
  const scriptPath = join(PACKAGE_ROOT, "python", script);

  return {
    name,
    version: "unknown",
    run: async (
      docs: readonly GroundTruthDocument[],
    ): Promise<AdapterOutcome> => {
      if (!existsSync(pythonBin)) {
        return {
          status: "unavailable",
          reason: `virtualenv not found at ${venvDir}; create it per REPRODUCING.md`,
        };
      }

      const job = JSON.stringify({
        docs: docs.map(({ id, language, text }) => ({ id, language, text })),
      });

      const proc = Bun.spawn([pythonBin, scriptPath], {
        stdin: new TextEncoder().encode(job),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        return {
          status: "unavailable",
          reason: `python adapter exited ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
        };
      }

      let parsed: PythonResult;
      try {
        parsed = JSON.parse(stdout) as PythonResult;
      } catch {
        return {
          status: "unavailable",
          reason: `could not parse adapter output: ${stdout.slice(0, 200)}`,
        };
      }

      const predictions = new Map<string, readonly NativePrediction[]>();
      for (const { id, entities } of parsed.results) {
        predictions.set(id, entities);
      }

      return {
        status: "ok",
        predictions,
        timing: {
          initSeconds: parsed.initSeconds,
          coldSeconds: parsed.coldSeconds,
          warmSeconds: parsed.warmSeconds,
          totalChars: parsed.totalChars,
        },
        reportedVersion: parsed.version,
        notes: parsed.activeDetectors
          ? `active detectors: ${parsed.activeDetectors.join(", ")}`
          : undefined,
      };
    },
  };
};
