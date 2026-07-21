import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_DETECTION_BATCH_VERSION,
  type ExternalDetectionBatch,
  convert_external_detection_batch,
} from "../native";
import { loadNativeAnonymizeBinding } from "../native-node";
import { convert_external_detection_batch as convertWasmExternalDetectionBatch } from "../wasm";

const binding = loadNativeAnonymizeBinding();
const document = new TextEncoder().encode("😀Alice signed.");
const sha256 = createHash("sha256").update(document).digest("hex");

type FakeProviderSpan = {
  offsetUnit: ExternalDetectionBatch["offsetUnit"];
  start: number;
  end: number;
};

const fakeProviderBatch = (
  { offsetUnit, start, end }: FakeProviderSpan = {
    offsetUnit: "unicode-code-point",
    start: 1,
    end: 6,
  },
): ExternalDetectionBatch => ({
  version: EXTERNAL_DETECTION_BATCH_VERSION,
  document: { sha256 },
  offsetUnit,
  provider: {
    id: "fake-provider",
    name: "Deterministic fake provider",
    version: "1.0.0",
  },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [
    {
      id: "fake-person-1",
      start,
      end,
      label: "PER",
      score: 0.99,
    },
  ],
});

describe("ExternalDetectionBatch v1", () => {
  test("converts every source unit to JavaScript caller offsets", () => {
    const spans: readonly FakeProviderSpan[] = [
      { offsetUnit: "utf8-byte", start: 4, end: 9 },
      { offsetUnit: "utf16-code-unit", start: 2, end: 7 },
      { offsetUnit: "unicode-code-point", start: 1, end: 6 },
    ];
    for (const span of spans) {
      expect(
        convert_external_detection_batch({
          binding,
          document,
          batch: fakeProviderBatch(span),
        }),
      ).toEqual([
        {
          start: 2,
          end: 7,
          label: "person",
          score: 0.99,
          providerId: "fake-provider",
          detectionId: "fake-person-1",
        },
      ]);
    }
  });

  test("fails closed on stale bytes and unknown contract fields", () => {
    const stale = fakeProviderBatch();
    stale.document.sha256 = "0".repeat(64);
    expect(() =>
      convert_external_detection_batch({ binding, document, batch: stale }),
    ).toThrow("sha256 does not match");

    const unknown = JSON.stringify({
      ...fakeProviderBatch(),
      legacyOffsetGuessing: true,
    });
    expect(() =>
      convert_external_detection_batch({ binding, document, batch: unknown }),
    ).toThrow("unknown field");
  });

  test("WASM rejects a stale injected binding at the surface boundary", async () => {
    const staleBinding = new Proxy(binding, {
      get: (target, property, receiver) =>
        property === "convertExternalDetectionBatch"
          ? undefined
          : Reflect.get(target, property, receiver),
    });

    let caught: unknown;
    try {
      await convertWasmExternalDetectionBatch(document, fakeProviderBatch(), {
        binding: staleBinding,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new TypeError("expected the stale WASM binding to be rejected");
    }
    expect(caught.message).toBe(
      "wasm binding module does not expose the native anonymize surface",
    );
  });
});
