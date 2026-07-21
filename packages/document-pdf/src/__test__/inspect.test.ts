import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { inspectPdf, PdfInspectionError } from "../index";

const fixture = (name: string): Uint8Array =>
  readFileSync(
    join(
      import.meta.dir,
      "../../../../crates/anonymize-pdf-core/tests/fixtures",
      name,
    ),
  );

describe("PDF inspection contract", () => {
  test("reports unobserved page content instead of claiming coverage", () => {
    const inspection = inspectPdf(fixture("minimal-text.pdf"));
    expect(inspection.contractVersion).toBe(1);
    expect(inspection.pageCount).toBe(1);
    expect(inspection.coverage).toEqual({
      status: "partial",
      gaps: ["page-content-not-observed"],
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

  test("validates renderer observations at the native boundary", () => {
    expect(() =>
      inspectPdf(fixture("minimal-text.pdf"), {
        pageObservations: [
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
                source: "embedded-text",
              },
            ],
            rendered: true,
            textLayer: "complete",
            ocr: "not-run",
            imageCount: 0,
          },
        ],
      }),
    ).toThrow(PdfInspectionError);
    try {
      inspectPdf(fixture("minimal-text.pdf"), {
        pageObservations: [
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
                source: "embedded-text",
              },
            ],
            rendered: true,
            textLayer: "complete",
            ocr: "not-run",
            imageCount: 0,
          },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PdfInspectionError);
      expect((error as PdfInspectionError).code).toBe("invalid-observation");
    }
  });
});
