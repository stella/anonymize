import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  PDF_LOCAL_PROVIDER_ERROR_CODES,
  PdfLocalProviderError,
  anonymizePdfRaster,
  inspectPdf,
  renderPdfWithPopplerTesseract,
} from "../index";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../../../crates/anonymize-pdf-core/tests/fixtures/minimal-text.pdf",
  ),
);

const pdfWithPageSize = (width: number, height: number): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources <<>> /Contents 4 0 R >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
};

let fakeDirectory = "";
let pdftoppmPath = "";
let malformedPdftoppmPath = "";
let slowPdftoppmPath = "";
let tesseractPath = "";

const executable = async (name: string, body: string): Promise<string> => {
  const path = join(fakeDirectory, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`, {
    flag: "wx",
    mode: 0o700,
  });
  await chmod(path, 0o700);
  return path;
};

beforeAll(async () => {
  fakeDirectory = await mkdtemp(join(tmpdir(), "stella pdf provider test-"));
  pdftoppmPath = await executable(
    "fake pdftoppm",
    `
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftoppm version 1.2.3\\n");
  process.exit(0);
}
const prefix = args.at(-1);
if (!args.includes("-singlefile") || args[args.indexOf("-f") + 1] !== "1" || args[args.indexOf("-l") + 1] !== "1") {
  process.exit(2);
}
const pixels = Buffer.alloc(612 * 792 * 3, 255);
writeFileSync(prefix + ".ppm", Buffer.concat([Buffer.from("P6\\n612 792\\n255\\n"), pixels]));
`,
  );
  malformedPdftoppmPath = await executable(
    "malformed pdftoppm",
    `
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftoppm version 1.2.3\\n");
  process.exit(0);
}
writeFileSync(args.at(-1) + ".ppm", "P3\\n1 1\\n255\\n0 0 0");
`,
  );
  slowPdftoppmPath = await executable(
    "slow pdftoppm",
    `
setTimeout(() => process.exit(0), 1000);
`,
  );
  tesseractPath = await executable(
    "fake tesseract",
    `
if (process.argv.includes("--version")) {
  process.stdout.write("tesseract 5.4.1\\n");
  process.exit(0);
}
process.stdout.write("level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n");
process.stdout.write("5\\t1\\t1\\t1\\t1\\t1\\t72\\t80\\t36\\t12\\t99\\tAlice\\n");
process.stdout.write("5\\t1\\t1\\t1\\t1\\t2\\t112\\t80\\t24\\t12\\t99\\tBob\\n");
`,
  );
});

afterAll(async () => {
  if (fakeDirectory) await rm(fakeDirectory, { force: true, recursive: true });
});

const detectorResult = {
  resolvedEntities: [
    {
      start: 0,
      end: 5,
      label: "PERSON",
      text: "Alice Bob",
      score: 1,
      source: "test",
    },
  ],
  redaction: {
    redactedText: "[PERSON]",
    redactionMap: new Map<string, string>(),
    operatorMap: new Map(),
    entityCount: 1,
  },
};

describe("local Poppler/Tesseract PDF provider", () => {
  test("renders and OCRs sequentially into the destructive rewrite contract", async () => {
    const rendered = await renderPdfWithPopplerTesseract({
      document: source,
      dpi: 72,
      ocrLanguage: "eng",
      pdftoppmPath,
      tesseractPath,
    });
    expect(rendered.pages[0]?.observation.glyphs).toMatchObject([
      { start: 0, end: 5 },
      { start: 6, end: 9 },
    ]);

    expect(rendered.provider).toEqual({
      providerId: "poppler-tesseract-local",
      rendererName: "Poppler pdftoppm",
      rendererVersion: "1.2.3",
      ocrName: "Tesseract OCR",
      ocrVersion: "5.4.1",
      ocrLanguage: "eng",
    });
    expect(rendered.pages).toHaveLength(1);
    expect(rendered.pages[0]?.observation).toMatchObject({
      pageIndex: 0,
      widthPoints: 612,
      heightPoints: 792,
      text: "Alice Bob",
      rendered: true,
      textLayer: "absent",
      ocr: "complete",
    });

    const result = anonymizePdfRaster({
      document: source,
      pipeline: {
        redactText: () => detectorResult,
        redactTextWithCallerDetections: () => detectorResult,
      },
      provider: rendered.provider,
      pages: rendered.pages,
    });

    expect(result.certificate).toMatchObject({
      detectionCount: 1,
      structurePixelRewriteVerified: true,
      piiCleanGuaranteed: false,
      provider: { ocrLanguage: "eng" },
    });
    expect(inspectPdf(result.document).risks).toMatchObject({
      annotationCount: 0,
      embeddedFileCount: 0,
      metadataStreamCount: 0,
    });
  });

  test("rejects mixed and option-shaped OCR languages before execution", async () => {
    await expect(
      renderPdfWithPopplerTesseract({
        document: source,
        dpi: 72,
        ocrLanguage: "eng+deu",
        pdftoppmPath,
        tesseractPath,
      }),
    ).rejects.toMatchObject({
      code: PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOptions,
    });

    await expect(
      renderPdfWithPopplerTesseract({
        document: source,
        dpi: 72,
        ocrLanguage: "--psm",
        pdftoppmPath,
        tesseractPath,
      }),
    ).rejects.toMatchObject({
      code: PDF_LOCAL_PROVIDER_ERROR_CODES.invalidOptions,
    });
  });

  test("fails closed on malformed renderer output", async () => {
    await expect(
      renderPdfWithPopplerTesseract({
        document: source,
        dpi: 72,
        ocrLanguage: "eng",
        pdftoppmPath: malformedPdftoppmPath,
        tesseractPath,
      }),
    ).rejects.toBeInstanceOf(PdfLocalProviderError);
  });

  test("rejects projected raster limits before invoking Poppler", async () => {
    await expect(
      renderPdfWithPopplerTesseract({
        document: pdfWithPageSize(100_000, 100_000),
        dpi: 72,
        ocrLanguage: "eng",
        pdftoppmPath: join(fakeDirectory, "must-not-run-pdftoppm"),
        tesseractPath: join(fakeDirectory, "must-not-run-tesseract"),
      }),
    ).rejects.toMatchObject({
      code: PDF_LOCAL_PROVIDER_ERROR_CODES.limitExceeded,
    });
  });

  test("keeps fractional native page geometry instead of PPM rounding", async () => {
    const rendered = await renderPdfWithPopplerTesseract({
      document: pdfWithPageSize(595.28, 841.89),
      dpi: 72,
      ocrLanguage: "eng",
      pdftoppmPath,
      tesseractPath,
    });

    const observation = rendered.pages[0]?.observation;
    expect(observation?.widthPoints).toBeCloseTo(595.28, 4);
    expect(observation?.heightPoints).toBeCloseTo(841.89, 4);
  });

  test("bounds hung executables with a timeout", async () => {
    await expect(
      renderPdfWithPopplerTesseract({
        document: source,
        dpi: 72,
        ocrLanguage: "eng",
        pdftoppmPath: slowPdftoppmPath,
        tesseractPath,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      code: PDF_LOCAL_PROVIDER_ERROR_CODES.executableFailed,
    });
  });
});
