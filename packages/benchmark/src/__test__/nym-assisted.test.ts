import { describe, expect, test } from "bun:test";

import {
  convert_external_detection_batch,
  loadNativeAnonymizeBinding,
} from "@stll/anonymize";

import {
  buildNymExternalDetectionBatch,
  mapNymDetections,
  NYM_PROVIDER_VERSION,
  parseNymResult,
} from "../adapters/nym-assisted";

describe("Nym assisted provider contract", () => {
  test("rejects any model revision other than the reviewed pin", () => {
    expect(() =>
      parseNymResult({
        version: "moving-main",
        initSeconds: 0,
        coldSeconds: 0,
        warmSeconds: 0,
        results: [],
      }),
    ).toThrow("pinned model");
  });

  test("validates scores and offsets before native import", () => {
    expect(() =>
      parseNymResult({
        version: NYM_PROVIDER_VERSION,
        initSeconds: 0,
        coldSeconds: 0,
        warmSeconds: 0,
        results: [
          {
            id: "de-1",
            detections: [{ start: 4, end: 2, label: "GIVEN_NAME", score: 2 }],
          },
        ],
      }),
    ).toThrow("offsets");
  });

  test("merges adjacent name pieces after canonical mapping", () => {
    expect(
      mapNymDetections("😀Mara Winterfeld", [
        { start: 1, end: 5, label: "GIVEN_NAME", score: 0.91 },
        { start: 6, end: 16, label: "SURNAME", score: 0.84 },
      ]),
    ).toEqual([
      {
        start: 1,
        end: 16,
        label: "GIVEN_NAME",
        score: 0.84,
        entityLabel: "person",
      },
    ]);
  });

  test("native import converts model code points to JavaScript UTF-16", () => {
    const text = "😀Mara Winterfeld";
    const batch = buildNymExternalDetectionBatch(text, [
      { start: 1, end: 5, label: "GIVEN_NAME", score: 0.91 },
      { start: 6, end: 16, label: "SURNAME", score: 0.84 },
    ]);
    expect(
      convert_external_detection_batch(new TextEncoder().encode(text), batch, {
        binding: loadNativeAnonymizeBinding(),
      }),
    ).toEqual([
      {
        start: 2,
        end: 17,
        label: "person",
        score: 0.84,
        providerId: "wismut-nym-pii-multilingual-small-int8",
        detectionId: "nym-1",
      },
    ]);
  });

  test("drops unsupported concepts instead of gaming legal coverage", () => {
    const batch = buildNymExternalDetectionBatch("Alter 41", [
      { start: 6, end: 8, label: "AGE", score: 0.99 },
    ]);
    expect(batch.detections).toEqual([]);
    expect(batch.labelMap).toEqual([]);
    expect(batch.offsetUnit).toBe("unicode-code-point");
  });
});
