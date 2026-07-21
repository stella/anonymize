import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { anonymizePdfRaster, inspectPdf, PdfRasterError } from "../index";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text.pdf",
  ),
);
const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const pixels = new Uint8Array(17 * 22 * 3).fill(255);
const request = {
  contractVersion: 1,
  sourceSha256: sha256(source),
  provider: {
    providerId: "synthetic-node-test",
    rendererName: "synthetic-renderer",
    rendererVersion: "1.0.0",
    ocrName: "synthetic-ocr",
    ocrVersion: "1.0.0",
  },
  fillRgb: [0, 0, 0] as const,
  pages: [
    {
      pageIndex: 0,
      widthPoints: 612,
      heightPoints: 792,
      widthPixels: 17,
      heightPixels: 22,
      pixelSha256: sha256(pixels),
      rendering: "complete" as const,
      ocr: "complete" as const,
      redactions: [{ left: 72, bottom: 396, right: 216, top: 540 }],
    },
  ],
} as const;

describe("PDF destructive raster anonymization", () => {
  test("creates a verified fresh image-only PDF", () => {
    const result = anonymizePdfRaster({
      document: source,
      request,
      pagePixels: [pixels],
    });
    expect(result.certificate).toMatchObject({
      contractVersion: 1,
      pageCount: 1,
      redactionCount: 1,
      outputVerified: true,
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

  test("rejects pixel buffers that do not match the asserted digest", () => {
    expect(() =>
      anonymizePdfRaster({
        document: source,
        request: {
          ...request,
          pages: [{ ...request.pages[0], pixelSha256: "00".repeat(32) }],
        },
        pagePixels: [pixels],
      }),
    ).toThrow(PdfRasterError);
  });
});
