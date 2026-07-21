import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_DETECTION_BATCH_MAX_BYTES,
  EXTERNAL_DETECTION_BATCH_VERSION,
  EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
  EXTERNAL_DETECTION_MAX_DETECTIONS,
  EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
  EXTERNAL_DETECTION_MAX_METADATA_BYTES,
  EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
  type ExternalDetectionBatch,
  convert_external_detection_batch,
} from "../native";
import { loadNativeAnonymizeBinding } from "../native-node";

const binding = loadNativeAnonymizeBinding();
const document = new TextEncoder().encode("😀Alice signed.");
const sha256 = createHash("sha256").update(document).digest("hex");

const fakeProviderBatch = (): ExternalDetectionBatch => ({
  version: EXTERNAL_DETECTION_BATCH_VERSION,
  document: { sha256 },
  offsetUnit: "unicode-code-point",
  provider: {
    id: "fake-provider",
    name: "Deterministic fake provider",
    version: "1.0.0",
  },
  labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
  detections: [
    {
      id: "fake-person-1",
      start: 1,
      end: 6,
      label: "PER",
      score: 0.99,
    },
  ],
});

describe("ExternalDetectionBatch v1", () => {
  test("public TypeScript limits exactly match the Rust contract", () => {
    const limitsJson = binding.externalDetectionLimitsJson?.();
    expect(limitsJson).toBeDefined();
    expect(JSON.parse(limitsJson ?? "null")).toEqual({
      batchMaxBytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
      documentMaxBytes: EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
      maxDetections: EXTERNAL_DETECTION_MAX_DETECTIONS,
      maxLabelMappings: EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
      maxMetadataBytes: EXTERNAL_DETECTION_MAX_METADATA_BYTES,
      providerIdMaxBytes: EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
    });
    expect(JSON.parse(limitsJson ?? "null")).toEqual({
      batchMaxBytes: 16_777_216,
      documentMaxBytes: 67_108_864,
      maxDetections: 100_000,
      maxLabelMappings: 4_096,
      maxMetadataBytes: 256,
      providerIdMaxBytes: 128,
    });
  });

  test("converts provider output to JavaScript caller-detection offsets", () => {
    expect(
      convert_external_detection_batch({
        binding,
        document,
        batch: fakeProviderBatch(),
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
});
