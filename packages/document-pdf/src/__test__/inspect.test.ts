import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  inspectPdf,
  PDF_MAX_OBSERVED_TEXT_UTF8_BYTES,
  PDF_LOADED_PAYLOAD_MAX_BYTES,
  PDF_OBSERVATIONS_JSON_MAX_BYTES,
  PDF_PAGE_DIMENSION_TOLERANCE_POINTS,
  PDF_STREAM_DECOMPRESSED_MAX_BYTES,
  PdfInspectionError,
} from "../index";

const fixture = (name: string): Uint8Array =>
  readFileSync(
    join(
      import.meta.dir,
      "../../../../crates/anonymize-pdf-core/tests/fixtures",
      name,
    ),
  );

describe("PDF inspection contract", () => {
  test("publishes the native observation limits", () => {
    expect(PDF_MAX_OBSERVED_TEXT_UTF8_BYTES).toBe(64 * 1024 * 1024);
    expect(PDF_LOADED_PAYLOAD_MAX_BYTES).toBe(128 * 1024 * 1024);
    expect(PDF_OBSERVATIONS_JSON_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(PDF_PAGE_DIMENSION_TOLERANCE_POINTS).toBe(0.25);
    expect(PDF_STREAM_DECOMPRESSED_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
  test("reports unobserved page content instead of claiming coverage", () => {
    const inspection = inspectPdf(fixture("minimal-text.pdf"));
    expect(inspection.contractVersion).toBe(1);
    expect(inspection.pageCount).toBe(1);
    expect(inspection.coverage).toEqual({
      status: "partial",
      gaps: [
        "observation-provider-not-identified",
        "page-content-not-observed",
      ],
    });
  });

  test("inventories structures that can retain sensitive content", () => {
    const { risks } = inspectPdf(fixture("risky-structures.pdf"));
    expect(risks.acroFormFieldCount).toBeGreaterThanOrEqual(1);
    expect(risks.annotationCount).toBeGreaterThanOrEqual(2);
    expect(risks.embeddedFileCount).toBeGreaterThanOrEqual(1);
    expect(risks.externalActionCount).toBeGreaterThanOrEqual(1);
    expect(risks.imageObjectCount).toBeGreaterThanOrEqual(1);
    expect(risks.javascriptActionCount).toBeGreaterThanOrEqual(1);
    expect(risks.metadataStreamCount).toBeGreaterThanOrEqual(1);
    expect(risks.optionalContentGroupCount).toBeGreaterThanOrEqual(1);
    expect(risks.signatureCount).toBeGreaterThanOrEqual(1);
    expect(risks.xfaEntryCount).toBeGreaterThanOrEqual(1);
  });

  test("labels complete observations as provider-attested", () => {
    const document = fixture("minimal-text.pdf");
    const inspection = inspectPdf(document, {
      observationBatch: {
        version: 1,
        document: {
          sha256: createHash("sha256").update(document).digest("hex"),
        },
        provider: { id: "test", name: "Test renderer", version: "1.0.0" },
        pages: [
          {
            pageIndex: 0,
            widthPoints: 612,
            heightPoints: 792,
            text: "Public fixture",
            glyphs: [
              {
                start: 0,
                end: 14,
                bounds: { left: 72, bottom: 700, right: 108, top: 712 },
                source: "embedded-text",
              },
            ],
            rendered: true,
            textLayer: "complete",
            ocr: "complete",
            imageCount: 0,
          },
        ],
      },
    });
    expect(inspection.coverage).toEqual({
      status: "provider-attested-full",
      gaps: [],
    });
    expect(inspection.observationProvider).toEqual({
      id: "test",
      name: "Test renderer",
      version: "1.0.0",
    });
  });

  test("validates renderer observations at the native boundary", () => {
    const document = fixture("minimal-text.pdf");
    const observationBatch = {
      version: 1 as const,
      document: {
        sha256: createHash("sha256").update(document).digest("hex"),
      },
      provider: { id: "test", name: "Test renderer", version: "1.0.0" },
      pages: [
        {
          pageIndex: 0,
          widthPoints: 100,
          heightPoints: 100,
          text: "😀",
          glyphs: [
            {
              start: 0,
              end: 1,
              bounds: { left: 0, bottom: 0, right: 10, top: 10 },
              source: "embedded-text" as const,
            },
          ],
          rendered: true,
          textLayer: "complete" as const,
          ocr: "not-run" as const,
          imageCount: 0,
        },
      ],
    };
    expect(() =>
      inspectPdf(document, {
        observationBatch,
      }),
    ).toThrow(PdfInspectionError);
    try {
      inspectPdf(document, {
        observationBatch,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PdfInspectionError);
      expect((error as PdfInspectionError).code).toBe("invalid-observation");
    }
  });
});
