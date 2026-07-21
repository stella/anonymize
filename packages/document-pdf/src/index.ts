import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  PDF_INSPECTION_ERROR_CODES,
  type PdfInspection,
  type PdfInspectionErrorCode,
  type PdfObservationBatch,
} from "./types";

export const PDF_INSPECTION_CONTRACT_VERSION = 1 as const;
export const PDF_OBSERVATION_BATCH_VERSION = 1 as const;
export const PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_STREAM_DECOMPRESSED_MAX_BYTES = 32 * 1024 * 1024;
export const PDF_LOADED_PAYLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const PDF_MAX_OBJECTS = 200_000;
export const PDF_MAX_OBJECT_NODES = 1_000_000;
export const PDF_MAX_OBJECT_DEPTH = 128;
export const PDF_MAX_PAGES = 10_000;
export const PDF_MAX_GLYPHS = 5_000_000;
export const PDF_MAX_PAGE_TEXT_UTF8_BYTES = 16 * 1024 * 1024;
export const PDF_MAX_OBSERVED_TEXT_UTF8_BYTES = 64 * 1024 * 1024;
export const PDF_OBSERVATIONS_JSON_MAX_BYTES = 64 * 1024 * 1024;
/** Renderer dimensions may differ by this many points due to numeric rounding. */
export const PDF_PAGE_DIMENSION_TOLERANCE_POINTS = 0.25;

export class PdfInspectionError extends Error {
  readonly code: PdfInspectionErrorCode;

  constructor(code: PdfInspectionErrorCode, message: string) {
    super(message);
    this.name = "PdfInspectionError";
    this.code = code;
  }
}

const errorCode = (message: string): PdfInspectionErrorCode => {
  const code = Object.values(PDF_INSPECTION_ERROR_CODES).find((candidate) =>
    message.startsWith(`${candidate}:`),
  );
  return code ?? PDF_INSPECTION_ERROR_CODES.invalidDocument;
};

export type InspectPdfOptions = {
  observationBatch?: PdfObservationBatch;
};

export const inspectPdf = (
  document: Uint8Array,
  options: InspectPdfOptions = {},
): PdfInspection => {
  const inspect = loadNativeAnonymizeBinding().inspectPdfJson;
  if (inspect === undefined) {
    throw new PdfInspectionError(
      PDF_INSPECTION_ERROR_CODES.invalidDocument,
      "Native anonymize binding does not expose PDF inspection",
    );
  }
  try {
    const observations = options.observationBatch;
    return JSON.parse(
      inspect(
        document,
        observations === undefined ? undefined : JSON.stringify(observations),
      ),
    ) as PdfInspection;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "PDF inspection failed";
    throw new PdfInspectionError(errorCode(message), message);
  }
};

export { PDF_INSPECTION_ERROR_CODES } from "./types";
export type {
  PdfGlyphObservation,
  PdfInspection,
  PdfInspectionErrorCode,
  PdfInspectionGap,
  PdfObservationBatch,
  PdfObservationProvider,
  PdfPageInspection,
  PdfPageObservation,
  PdfRect,
  PdfRiskInventory,
} from "./types";
