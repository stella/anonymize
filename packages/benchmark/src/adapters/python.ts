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
 * A non-zero exit whose stderr names a missing import/model is a setup gap
 * (the venv exists but its requirements or model wheels are not installed), not
 * a crash. These are skipped with instructions; every other failure is fatal.
 */
const SETUP_ERROR_MARKERS = [
  "ModuleNotFoundError",
  "ImportError",
  "No module named",
  "Can't find model", // spaCy model wheel not installed
  "OSError: [E050]", // spaCy: model not found
] as const;

const isSetupError = (stderr: string): boolean =>
  SETUP_ERROR_MARKERS.some((marker) => stderr.includes(marker));

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
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        // A missing dependency (venv exists but was never `uv pip install`-ed,
        // or a model wheel is absent) is a setup gap, not a bug: skip it with
        // the fix, exactly like a missing venv. Any other non-zero exit is a
        // real crash in the adapter or the library and must fail the run loudly
        // rather than be silently downgraded to "unavailable".
        if (isSetupError(stderr)) {
          return {
            status: "unavailable",
            reason: `${name} venv is incomplete (${tail}); reinstall it per REPRODUCING.md`,
          };
        }
        throw new Error(`${name} adapter crashed (exit ${exitCode}): ${tail}`);
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
