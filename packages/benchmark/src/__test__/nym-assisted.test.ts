import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  convert_external_detection_batch,
  loadNativeAnonymizeBinding,
  type ExternalDetectionBatch,
} from "@stll/anonymize";

import { NYM_PROVIDER_VERSION, parseNymResult } from "../adapters/nym-assisted";

describe("native Nym assisted provider contract", () => {
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

  test("keeps the host protocol to an opaque native batch", () => {
    expect(
      parseNymResult({
        version: NYM_PROVIDER_VERSION,
        initSeconds: 1,
        coldSeconds: 2,
        warmSeconds: 3,
        results: [{ id: "de-1", batchJson: "{}" }],
      }).results,
    ).toEqual([{ id: "de-1", batchJson: "{}" }]);
    expect(() =>
      parseNymResult({
        version: NYM_PROVIDER_VERSION,
        initSeconds: 0,
        coldSeconds: 0,
        warmSeconds: 0,
        results: [{ id: "de-1", batchJson: "{}", detections: [] }],
      }),
    ).toThrow("only id and batchJson");
  });

  test("native import converts provider code points to JavaScript UTF-16", () => {
    const text = "😀Mara Winterfeld";
    const document = new TextEncoder().encode(text);
    const batch: ExternalDetectionBatch = {
      version: 1,
      document: {
        sha256: createHash("sha256").update(document).digest("hex"),
      },
      offsetUnit: "unicode-code-point",
      provider: {
        id: "wismut-nym-pii-multilingual-small-int8",
        name: "Nym PII multilingual small (int8)",
        version: NYM_PROVIDER_VERSION,
      },
      labelMap: [{ providerLabel: "GIVEN_NAME", entityLabel: "person" }],
      detections: [
        {
          id: "nym-1",
          start: 1,
          end: 16,
          label: "GIVEN_NAME",
          score: 0.84,
        },
      ],
    };
    expect(
      convert_external_detection_batch(document, batch, {
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
});
