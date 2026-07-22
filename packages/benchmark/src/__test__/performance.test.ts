import { describe, expect, test } from "bun:test";

import {
  assertCanonicalHost,
  CANONICAL_HOST_LABEL,
  parseCpuList,
  type HostProfile,
  type HostSnapshot,
} from "../performance/host";
import { buildPerformanceInput } from "../performance/input";
import {
  assertPerformanceReport,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
} from "../performance/report";
import {
  buildPerformanceWorkerInvocation,
  parsePerformanceArgs,
} from "../performance/run";
import { summarize } from "../performance/statistics";

describe("canonical performance statistics", () => {
  test("reports median, MAD, and nearest-rank p95 without sorting samples", () => {
    const values = [9, 1, 4, 2, 3];
    expect(summarize(values)).toEqual({
      samples: values,
      median: 3,
      medianAbsoluteDeviation: 1,
      p95: 9,
    });
  });

  test("builds deterministic exact-byte scaling inputs from public fixtures", async () => {
    const first = await buildPerformanceInput(48 * 1024);
    const second = await buildPerformanceInput(48 * 1024);
    expect(new TextEncoder().encode(first.text)).toHaveLength(48 * 1024);
    expect(first.sha256).toBe(second.sha256);
  });

  test("enforces the canonical sample floor and scale set", () => {
    expect(() => parsePerformanceArgs(["--canonical", "--samples=19"])).toThrow(
      "at least 3 warmups and 20 samples",
    );
    expect(() =>
      parsePerformanceArgs(["--canonical", "--sizes-kib=48,1024"]),
    ).toThrow("standard 48 KiB–1 MiB scale set");
    expect(parsePerformanceArgs(["--samples=1", "--warmups=1"]).samples).toBe(
      1,
    );
  });

  test("pins canonical workers and leaves local workers unpinned", () => {
    const canonical = buildPerformanceWorkerInvocation(49_152, {
      type: "canonical",
      benchmarkCpu: 6,
    });
    expect(canonical.command).toBe("taskset");
    expect(canonical.args.slice(0, 3)).toEqual([
      "--cpu-list",
      "6",
      process.execPath,
    ]);
    expect(canonical.args.at(-1)).toBe("49152");

    const local = buildPerformanceWorkerInvocation(49_152, { type: "local" });
    expect(local.command).toBe(process.execPath);
    expect(local.args).not.toContain("--cpu-list");
  });
});

describe("canonical performance host", () => {
  const profile: HostProfile = {
    schemaVersion: 1,
    label: CANONICAL_HOST_LABEL,
    platform: "linux",
    architecture: "x64",
    cpuModel: "Canonical CPU",
    logicalCores: 8,
    totalMemoryBytes: 16_000_000_000,
    benchmarkCpu: 6,
    maximumLoadPerCore: 0.1,
    governor: "performance",
    turbo: "disabled",
  };
  const snapshot: HostSnapshot = {
    eventName: "workflow_dispatch",
    repository: "stella/anonymize",
    ref: "refs/heads/main",
    platform: "linux",
    architecture: "x64",
    cpuModel: "Canonical CPU",
    logicalCores: 8,
    totalMemoryBytes: 16_000_000_000,
    loadOneMinute: 0.4,
    isolatedCpus: [6],
    onlineCpus: [0, 1, 2, 3, 4, 5, 6],
    benchmarkCpuSiblings: [6],
    tasksetAvailable: true,
    governors: ["performance"],
    turboDisabled: true,
  };

  test("accepts only a matching, quiet, trusted host", () => {
    expect(() => assertCanonicalHost(profile, snapshot)).not.toThrow();
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, eventName: "pull_request" }),
    ).toThrow("trusted repository event");
    expect(() =>
      assertCanonicalHost(profile, {
        ...snapshot,
        ref: "refs/heads/feature",
      }),
    ).toThrow("trusted repository event");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, loadOneMinute: 8 }),
    ).toThrow("load exceeds");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, turboDisabled: false }),
    ).toThrow("turbo/boost");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, isolatedCpus: [] }),
    ).toThrow("online and isolated");
    expect(() =>
      assertCanonicalHost(profile, {
        ...snapshot,
        benchmarkCpuSiblings: [6, 7],
        onlineCpus: [...snapshot.onlineCpus, 7],
      }),
    ).toThrow("SMT siblings must be offline");
  });

  test("parses Linux CPU lists without accepting ambiguous syntax", () => {
    expect(
      parseCpuList({ value: "1-3,6,8-9\n", context: "test CPU list" }),
    ).toEqual([1, 2, 3, 6, 8, 9]);
    expect(parseCpuList({ value: "", context: "test CPU list" })).toEqual([]);
    expect(() =>
      parseCpuList({ value: "01", context: "test CPU list" }),
    ).toThrow("invalid CPU id");
  });
});

describe("canonical performance report schema", () => {
  test("accepts aggregate output identity and rejects unknown fields", () => {
    const distribution = {
      samples: [1],
      median: 1,
      medianAbsoluteDeviation: 0,
      p95: 1,
    };
    const report = {
      schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
      createdAt: "2026-07-22T00:00:00.000Z",
      gitSha: "0123456",
      mode: "local",
      policy: "development-only",
      configuration: {
        warmups: 1,
        samples: 1,
        inputBytes: [49_152],
        processIsolation: "fresh-process-per-sample",
      },
      fixture: {
        kind: "public-safe-synthetic",
        source: "packages/benchmark/fixtures/en.json",
        sha256: "a".repeat(64),
      },
      machine: {
        platform: "linux",
        architecture: "x64",
        release: "test",
        cpuModel: "test",
        logicalCores: 1,
        totalMemoryBytes: 1,
        freeMemoryBytes: 0,
        benchmarkCpu: null,
        hostnameSha256: "b".repeat(64),
        bunVersion: "1.3.14",
        nodeVersion: "v22",
      },
      results: [
        {
          inputBytes: 49_152,
          inputCharacters: 49_152,
          inputSha256: "c".repeat(64),
          outputCount: 1,
          outputDigest: "d".repeat(64),
          startupSeconds: distribution,
          initSeconds: distribution,
          coldSeconds: distribution,
          warmSeconds: distribution,
          warmCharactersPerSecond: distribution,
        },
      ],
    };
    expect(() => assertPerformanceReport(report)).not.toThrow();
    expect(() =>
      assertPerformanceReport({ ...report, mode: "canonical" }),
    ).toThrow("must record their pinned benchmark CPU");
    expect(() =>
      assertPerformanceReport({
        ...report,
        mode: "canonical",
        machine: { ...report.machine, benchmarkCpu: 6 },
      }),
    ).not.toThrow();
    expect(() =>
      assertPerformanceReport({ ...report, text: "forbidden" }),
    ).toThrow("forbids field text");
  });
});
