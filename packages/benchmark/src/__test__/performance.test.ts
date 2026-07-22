import { describe, expect, test } from "bun:test";

import {
  assertCanonicalHost,
  CANONICAL_HOST_LABEL,
  type HostProfile,
  type HostSnapshot,
} from "../performance/host";
import { buildPerformanceInput } from "../performance/input";
import {
  assertPerformanceReport,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
} from "../performance/report";
import { parsePerformanceArgs } from "../performance/run";
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
      assertPerformanceReport({ ...report, text: "forbidden" }),
    ).toThrow("forbids field text");
  });
});
