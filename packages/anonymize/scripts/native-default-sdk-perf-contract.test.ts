import { expect, test } from "bun:test";
import {
  nativeDefaultSdkProcessFailure,
  parseNativeDefaultSdkDiagnosticEvents,
  parseNativeDefaultSdkWorkerResult,
  type NativeDefaultSdkWorkerResult,
} from "./native-default-sdk-perf-contract";

const summary = { minMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 };
const fixture = {
  event: "native-default-sdk-perf-worker",
  language: null,
  preload: false,
  packageBytes: 100,
  fixtureCount: 1,
  loadMs: 1,
  warmupMs: 0,
  prepareMs: 1,
  runMs: 1,
  warmAvgMs: 1,
  prepareTopStages: [],
  prepareTopSlots: [],
  warmupTopStages: [],
  warmupTopSlots: [],
  runProfile: null,
  fixtureTimings: {
    cold: summary,
    warm: summary,
    byFixture: [
      {
        fixture: "case.txt",
        coldMs: 1,
        warmAvgMs: 1,
        entityCount: 1,
        redactedTextLength: 8,
      },
    ],
  },
  runTopFixtures: [
    { fixture: "case.txt", ms: 1, entityCount: 1, redactedTextLength: 8 },
  ],
  fixtureSignatures: [{ fixture: "case.txt", signature: "a".repeat(16) }],
} satisfies NativeDefaultSdkWorkerResult;

test("both worker preload states validate while every required field rejects absence", () => {
  for (const preload of [false, true]) {
    const value = { ...fixture, preload };
    expect(
      parseNativeDefaultSdkWorkerResult(JSON.parse(JSON.stringify(value))),
    ).toEqual(value);
  }
  for (const key of Object.keys(fixture)) {
    const missing = Object.fromEntries(
      Object.entries(fixture).filter(([name]) => name !== key),
    );
    expect(() => parseNativeDefaultSdkWorkerResult(missing), key).toThrow(
      TypeError,
    );
  }
  for (const preload of ["false", 0, 1, null, {}]) {
    expect(() =>
      parseNativeDefaultSdkWorkerResult({ ...fixture, preload }),
    ).toThrow(TypeError);
  }
});

test("worker measurements and signatures reject malformed numeric and nested domains", () => {
  for (const loadMs of [-1, Infinity, NaN, "1"]) {
    expect(() =>
      parseNativeDefaultSdkWorkerResult({ ...fixture, loadMs }),
    ).toThrow(TypeError);
  }
  for (const value of [
    { ...fixture, fixtureCount: 1.5 },
    {
      ...fixture,
      fixtureSignatures: [{ fixture: "case.txt", signature: "invalid" }],
    },
    {
      ...fixture,
      fixtureTimings: {
        ...fixture.fixtureTimings,
        byFixture: [{ fixture: "case.txt" }],
      },
    },
    { ...fixture, runTopFixtures: [null] },
  ])
    expect(() => parseNativeDefaultSdkWorkerResult(value)).toThrow(TypeError);
});

test("diagnostic envelopes preserve native events and reject malformed payloads", () => {
  const events = [{ stage: "prepare.total", elapsed_us: 1000 }];
  for (const envelope of [{ events }, { diagnostics: { events } }]) {
    expect(
      parseNativeDefaultSdkDiagnosticEvents(JSON.stringify(envelope)),
    ).toEqual(events);
  }
  expect(parseNativeDefaultSdkDiagnosticEvents(null)).toEqual([]);
  expect(parseNativeDefaultSdkDiagnosticEvents("{}")).toEqual([]);
  for (const envelope of [null, 1, { events: "invalid" }, { events: [null] }]) {
    expect(() =>
      parseNativeDefaultSdkDiagnosticEvents(JSON.stringify(envelope)),
    ).toThrow(TypeError);
  }
});

test("process creation failures retain their error without requiring captured output", () => {
  expect(
    nativeDefaultSdkProcessFailure({
      error: new Error("spawn unavailable"),
      stdout: null,
      stderr: null,
    }),
  ).toEqual(["spawn unavailable"]);
  expect(
    nativeDefaultSdkProcessFailure({ stdout: " output ", stderr: " warning " }),
  ).toEqual(["output", "warning"]);
});
