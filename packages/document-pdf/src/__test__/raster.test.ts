import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  anonymizePdfRaster,
  inspectPdf,
  PDF_MAX_PAGE_TEXT_UTF8_BYTES,
  PDF_MAX_OBSERVED_TEXT_UTF8_BYTES,
  PdfRasterError,
} from "../index";
import type { PdfPageObservation } from "../types";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text.pdf",
  ),
);
const pixels = new Uint8Array(17 * 22 * 3).fill(255);
const observation: PdfPageObservation = {
  pageIndex: 0,
  widthPoints: 612,
  heightPoints: 792,
  text: "Alice",
  glyphs: [
    {
      start: 0,
      end: 5,
      bounds: { left: 72, bottom: 396, right: 216, top: 540 },
      source: "ocr",
    },
  ],
  rendered: true,
  textLayer: "absent",
  ocr: "complete",
  imageCount: 0,
};
const provider = {
  providerId: "synthetic-node-test",
  rendererName: "synthetic-renderer",
  rendererVersion: "1.0.0",
  ocrName: "synthetic-ocr",
  ocrVersion: "1.0.0",
  ocrLanguage: "eng",
};

const detectorResult = (start?: number, end?: number) => ({
  resolvedEntities:
    start === undefined || end === undefined
      ? []
      : [
          {
            start,
            end,
            label: "PERSON",
            text: "Alice",
            score: 1,
            source: "test",
          },
        ],
  redaction: {
    redactedText: "[PERSON]",
    redactionMap: new Map<string, string>(),
    operatorMap: new Map(),
    entityCount: start === undefined ? 0 : 1,
  },
});
const pipeline = (start = 0, end = 5) => ({
  redactText: () => detectorResult(start, end),
  redactTextWithCallerDetections: () => detectorResult(start, end),
});

describe("PDF destructive raster anonymization", () => {
  test("detects text and creates a verified fresh image-only PDF", () => {
    const result = anonymizePdfRaster({
      document: source,
      pipeline: pipeline(),
      provider,
      pages: [{ observation, widthPixels: 17, heightPixels: 22, pixels }],
    });
    expect(result.certificate).toMatchObject({
      contractVersion: 1,
      pageCount: 1,
      detectionCount: 1,
      mappedRegionCount: 1,
      structurePixelRewriteVerified: true,
      piiCleanGuaranteed: false,
    });
    expect(Buffer.from(result.document).includes("Public fixture")).toBeFalse();
    expect(inspectPdf(result.document).risks).toMatchObject({
      annotationCount: 0,
      embeddedFileCount: 0,
      imageObjectCount: 1,
      metadataStreamCount: 0,
      signatureCount: 0,
    });
  });

  test("fails closed when a selected span lacks complete glyph geometry", () => {
    expect(() =>
      anonymizePdfRaster({
        document: source,
        pipeline: pipeline(0, 6),
        provider,
        pages: [{ observation, widthPixels: 17, heightPixels: 22, pixels }],
      }),
    ).toThrow(PdfRasterError);
  });

  test("never claims that an empty detector result proves the PDF PII-free", () => {
    const emptyPipeline = {
      redactText: () => detectorResult(),
      redactTextWithCallerDetections: () => detectorResult(),
    };
    const result = anonymizePdfRaster({
      document: source,
      pipeline: emptyPipeline,
      provider,
      pages: [{ observation, widthPixels: 17, heightPixels: 22, pixels }],
    });
    expect(result.certificate).toMatchObject({
      detectionCount: 0,
      mappedRegionCount: 0,
      structurePixelRewriteVerified: true,
      piiCleanGuaranteed: false,
    });
  });

  test("reports detector failures with a stable non-leaking code", () => {
    const failingPipeline = {
      redactText: () => {
        throw new Error("sensitive provider detail");
      },
      redactTextWithCallerDetections: () => detectorResult(),
    };

    try {
      anonymizePdfRaster({
        document: source,
        pipeline: failingPipeline,
        provider,
        pages: [{ observation, widthPixels: 17, heightPixels: 22, pixels }],
      });
      throw new Error("expected detector failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfRasterError);
      expect((error as PdfRasterError).code).toBe("detection-failed");
      expect((error as Error).message).toBe(
        "detection-failed: PDF raster detection failed",
      );
    }
  });

  test("rejects invalid pixel buffers before invoking detection", () => {
    let calls = 0;
    const countingPipeline = {
      redactText: () => {
        calls += 1;
        return detectorResult();
      },
      redactTextWithCallerDetections: () => detectorResult(),
    };

    expect(() =>
      anonymizePdfRaster({
        document: source,
        pipeline: countingPipeline,
        provider,
        pages: [
          {
            observation,
            widthPixels: 17,
            heightPixels: 22,
            pixels: pixels.subarray(1),
          },
        ],
      }),
    ).toThrow(PdfRasterError);
    expect(calls).toBe(0);
  });

  test("rejects oversized observed text before invoking detection", () => {
    let calls = 0;
    const recordDetectionCall = () => {
      calls += 1;
      return detectorResult();
    };
    const countingPipeline = {
      redactText: recordDetectionCall,
      redactTextWithCallerDetections: recordDetectionCall,
    };
    const oversizedObservation = {
      ...observation,
      text: "a".repeat(PDF_MAX_PAGE_TEXT_UTF8_BYTES + 1),
    };

    try {
      anonymizePdfRaster({
        document: source,
        pipeline: countingPipeline,
        provider,
        pages: [
          {
            observation: oversizedObservation,
            widthPixels: 17,
            heightPixels: 22,
            pixels,
          },
        ],
      });
      throw new Error("expected observed-text limit failure");
    } catch (error) {
      if (!(error instanceof PdfRasterError)) throw error;
      expect(error.code).toBe("limit-exceeded");
    }
    expect(calls).toBe(0);
  });

  test("rejects aggregate observed text limits before invoking detection", () => {
    let calls = 0;
    const recordDetectionCall = () => {
      calls += 1;
      return detectorResult();
    };
    const countingPipeline = {
      redactText: recordDetectionCall,
      redactTextWithCallerDetections: recordDetectionCall,
    };
    const pageText = "a".repeat(PDF_MAX_PAGE_TEXT_UTF8_BYTES);
    const pageCount =
      PDF_MAX_OBSERVED_TEXT_UTF8_BYTES / PDF_MAX_PAGE_TEXT_UTF8_BYTES;
    const pages = Array.from({ length: pageCount + 1 }, (_, pageIndex) => ({
      observation: {
        ...observation,
        pageIndex,
        text: pageIndex === pageCount ? "a" : pageText,
      },
      widthPixels: 17,
      heightPixels: 22,
      pixels,
    }));

    try {
      anonymizePdfRaster({
        document: source,
        pipeline: countingPipeline,
        provider,
        pages,
      });
      throw new Error("expected aggregate observed-text limit failure");
    } catch (error) {
      if (!(error instanceof PdfRasterError)) throw error;
      expect(error.code).toBe("limit-exceeded");
    }
    expect(calls).toBe(0);
  });
});
