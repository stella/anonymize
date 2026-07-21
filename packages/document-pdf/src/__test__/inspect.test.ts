import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  inspectPdf,
  PdfInspectionError,
  type PdfObservationBatch,
  type PdfPageObservation,
} from "../index";

const fixture = (name: string): Uint8Array =>
  readFileSync(
    join(
      import.meta.dir,
      "../../../../crates/anonymize-pdf-core/tests/fixtures",
      name,
    ),
  );

const observationBatch = (
  document: Uint8Array,
  pages: PdfObservationBatch["pages"],
): PdfObservationBatch => ({
  version: 1 as const,
  document: {
    sha256: createHash("sha256").update(document).digest("hex"),
  },
  provider: {
    id: "test-renderer",
    name: "Test Renderer",
    version: "1.0.0",
  },
  pages,
});

const completeObservation = (): PdfPageObservation =>
  JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text-observation.json",
      ),
      "utf8",
    ),
  ) as PdfPageObservation; // SAFETY: Generated and validated with the public fixture schema.

describe("PDF inspection contract", () => {
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

  test("reports truthful generated geometry as provider-attested", () => {
    const document = fixture("minimal-text.pdf");
    const observation = completeObservation();
    const inspection = inspectPdf(document, {
      observationBatch: observationBatch(document, [observation]),
    });
    expect(observation.glyphs[0]?.bounds).toEqual({
      left: 72,
      bottom: 717.516,
      right: 265.404,
      top: 728.616,
    });
    expect(inspection.coverage).toEqual({
      status: "provider-attested-full",
      gaps: [],
    });
  });

  test("validates renderer observations at the native boundary", () => {
    const document = fixture("minimal-text.pdf");
    const pages = [
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
    ];
    expect(() =>
      inspectPdf(document, {
        observationBatch: observationBatch(document, pages),
      }),
    ).toThrow(PdfInspectionError);
    try {
      inspectPdf(document, {
        observationBatch: observationBatch(document, pages),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PdfInspectionError);
      expect((error as PdfInspectionError).code).toBe("invalid-observation");
    }
  });

  test("normalizes observation JSON serialization failures", () => {
    const document = fixture("minimal-text.pdf");
    const batch = observationBatch(document, [completeObservation()]);
    const cyclic = { ...batch } as PdfObservationBatch & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    try {
      inspectPdf(document, { observationBatch: cyclic });
      throw new Error("cyclic observation batch did not fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfInspectionError);
      expect((error as PdfInspectionError).code).toBe("invalid-observation");
      expect((error as Error).message).toBe(
        "invalid-observation: PDF observation batch is not JSON-serializable",
      );
    }
  });
});
