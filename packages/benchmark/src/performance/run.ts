import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { benchmarkGitRevision } from "../git-revision";
import { verifyCanonicalHost } from "./host";
import {
  PERFORMANCE_INPUT_SOURCE,
  performanceInputSourceDigest,
} from "./input";
import {
  assertPerformanceReport,
  machineMetadata,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  type PerformanceReport,
  type PerformanceResult,
} from "./report";
import type { PerformanceSample } from "./sample";
import { summarize } from "./statistics";

const KIBIBYTE = 1024;
const DEFAULT_INPUT_BYTES = [
  48 * KIBIBYTE,
  256 * KIBIBYTE,
  512 * KIBIBYTE,
  1024 * KIBIBYTE,
] as const;
const DEFAULT_WARMUPS = 3;
const DEFAULT_SAMPLES = 20;

type CliOptions = {
  readonly mode: "local" | "canonical";
  readonly warmups: number;
  readonly samples: number;
  readonly inputBytes: readonly number[];
  readonly outputPath: string | undefined;
};

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const parsePerformanceArgs = (args: readonly string[]): CliOptions => {
  let mode: CliOptions["mode"] = "local";
  let warmups = DEFAULT_WARMUPS;
  let samples = DEFAULT_SAMPLES;
  let inputBytes: readonly number[] = DEFAULT_INPUT_BYTES;
  let outputPath: string | undefined;
  for (const argument of args) {
    if (argument === "--canonical") {
      mode = "canonical";
      continue;
    }
    const [name, value] = argument.split("=", 2);
    if (value === undefined) throw new Error(`unknown argument ${argument}`);
    if (name === "--warmups") {
      warmups = positiveInteger(value, name);
      continue;
    }
    if (name === "--samples") {
      samples = positiveInteger(value, name);
      continue;
    }
    if (name === "--sizes-kib") {
      inputBytes = value
        .split(",")
        .map((size) => positiveInteger(size, name) * KIBIBYTE);
      continue;
    }
    if (name === "--output") {
      if (value === "") throw new Error("--output must not be empty");
      outputPath = resolve(value);
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (
    inputBytes.some(
      (size) => size < DEFAULT_INPUT_BYTES[0] || size > DEFAULT_INPUT_BYTES[3],
    )
  ) {
    throw new Error("performance sizes must remain between 48 KiB and 1 MiB");
  }
  if (mode === "canonical") {
    if (warmups < DEFAULT_WARMUPS || samples < DEFAULT_SAMPLES) {
      throw new Error(
        "canonical mode requires at least 3 warmups and 20 samples",
      );
    }
    if (
      inputBytes.length !== DEFAULT_INPUT_BYTES.length ||
      inputBytes.some((size, index) => size !== DEFAULT_INPUT_BYTES[index])
    ) {
      throw new Error(
        "canonical mode requires the standard 48 KiB–1 MiB scale set",
      );
    }
  }
  return { mode, warmups, samples, inputBytes, outputPath };
};

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly sample: PerformanceSample };

type IsolatedSample = PerformanceSample & { readonly startupSeconds: number };

const runIsolatedSample = (inputBytes: number): Promise<IsolatedSample> =>
  new Promise((resolveSample, reject) => {
    const spawnedAt = performance.now();
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dir, "worker.ts"), `${inputBytes}`],
      {
        cwd: resolve(import.meta.dir, "..", "..", "..", ".."),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let startupSeconds: number | undefined;
    let sample: PerformanceSample | undefined;
    let standardError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      standardError += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch (error) {
        reject(
          new Error("performance worker emitted invalid JSON", {
            cause: error,
          }),
        );
        child.kill();
        return;
      }
      if (message.type === "ready") {
        if (startupSeconds !== undefined) {
          reject(new Error("performance worker emitted ready twice"));
          child.kill();
          return;
        }
        startupSeconds = (performance.now() - spawnedAt) / 1000;
        return;
      }
      sample = message.sample;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `performance worker failed with code ${code}: ${standardError.trim()}`,
          ),
        );
        return;
      }
      if (startupSeconds === undefined || sample === undefined) {
        reject(new Error("performance worker protocol was incomplete"));
        return;
      }
      resolveSample({ ...sample, startupSeconds });
    });
  });

const rotatedSizes = (
  sizes: readonly number[],
  round: number,
): readonly number[] => {
  const offset = round % sizes.length;
  return [...sizes.slice(offset), ...sizes.slice(0, offset)];
};

const assertSameOutput = (
  expected: IsolatedSample,
  actual: IsolatedSample,
): void => {
  if (
    expected.inputBytes !== actual.inputBytes ||
    expected.inputSha256 !== actual.inputSha256 ||
    expected.inputCharacters !== actual.inputCharacters ||
    expected.outputCount !== actual.outputCount ||
    expected.outputDigest !== actual.outputDigest
  ) {
    throw new Error(
      `performance output changed for ${actual.inputBytes} bytes`,
    );
  }
};

export const runPerformance = async (
  options: CliOptions,
): Promise<PerformanceReport> => {
  if (options.mode === "canonical") verifyCanonicalHost();
  const gitSha = benchmarkGitRevision();
  if (options.mode === "canonical" && gitSha.endsWith("-dirty")) {
    throw new Error("canonical performance runs require a clean Git worktree");
  }

  const expected = new Map<number, IsolatedSample>();
  for (let round = 0; round < options.warmups; round += 1) {
    for (const size of rotatedSizes(options.inputBytes, round)) {
      process.stderr.write(
        `warmup ${round + 1}/${options.warmups}: ${size} bytes\n`,
      );
      const sample = await runIsolatedSample(size);
      const previous = expected.get(size);
      if (previous === undefined) expected.set(size, sample);
      else assertSameOutput(previous, sample);
    }
  }

  const measured = new Map<number, IsolatedSample[]>();
  for (const size of options.inputBytes) measured.set(size, []);
  for (let round = 0; round < options.samples; round += 1) {
    for (const size of rotatedSizes(options.inputBytes, round)) {
      process.stderr.write(
        `sample ${round + 1}/${options.samples}: ${size} bytes\n`,
      );
      const sample = await runIsolatedSample(size);
      const previous = expected.get(size);
      if (previous === undefined)
        throw new Error("warmup output is unavailable");
      assertSameOutput(previous, sample);
      measured.get(size)?.push(sample);
    }
  }

  const results: PerformanceResult[] = options.inputBytes.map((size) => {
    const samples = measured.get(size);
    const identity = expected.get(size);
    if (samples === undefined || identity === undefined) {
      throw new Error(`performance samples are unavailable for ${size} bytes`);
    }
    return {
      inputBytes: size,
      inputCharacters: identity.inputCharacters,
      inputSha256: identity.inputSha256,
      outputCount: identity.outputCount,
      outputDigest: identity.outputDigest,
      startupSeconds: summarize(
        samples.map(({ startupSeconds }) => startupSeconds),
      ),
      initSeconds: summarize(samples.map(({ initSeconds }) => initSeconds)),
      coldSeconds: summarize(samples.map(({ coldSeconds }) => coldSeconds)),
      warmSeconds: summarize(samples.map(({ warmSeconds }) => warmSeconds)),
      warmCharactersPerSecond: summarize(
        samples.map(
          ({ inputCharacters, warmSeconds }) => inputCharacters / warmSeconds,
        ),
      ),
    };
  });
  const report: PerformanceReport = {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    gitSha,
    mode: options.mode,
    policy: "development-only",
    configuration: {
      warmups: options.warmups,
      samples: options.samples,
      inputBytes: [...options.inputBytes],
      processIsolation: "fresh-process-per-sample",
    },
    fixture: {
      kind: "public-safe-synthetic",
      source: PERFORMANCE_INPUT_SOURCE,
      sha256: performanceInputSourceDigest(),
    },
    machine: await machineMetadata(),
    results,
  };
  assertPerformanceReport(report);
  return report;
};

if (import.meta.main) {
  const options = parsePerformanceArgs(process.argv.slice(2));
  const report = await runPerformance(options);
  const serialized = `${JSON.stringify(report, undefined, 2)}\n`;
  if (options.outputPath === undefined) {
    process.stdout.write(serialized);
  } else {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    await Bun.write(options.outputPath, serialized);
    process.stderr.write(`wrote ${options.outputPath}\n`);
  }
}
