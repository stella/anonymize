import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  PDF_INSPECTION_ERROR_CODES,
  type PdfInspection,
  type PdfInspectionErrorCode,
  type PdfPageObservation,
} from "./types";

export const PDF_INSPECTION_CONTRACT_VERSION = 1 as const;
export const PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_DECOMPRESSED_MAX_BYTES = 128 * 1024 * 1024;
export const PDF_MAX_OBJECTS = 200_000;
export const PDF_MAX_OBJECT_NODES = 1_000_000;
export const PDF_MAX_OBJECT_DEPTH = 128;
export const PDF_MAX_PAGES = 10_000;
export const PDF_MAX_GLYPHS = 5_000_000;
export const PDF_MAX_PAGE_TEXT_UTF8_BYTES = 16 * 1024 * 1024;
export const PDF_MAX_OBSERVATION_TEXT_UTF8_BYTES = 64 * 1024 * 1024;
export const PDF_MAX_OBSERVATION_JSON_BYTES = 256 * 1024 * 1024;

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
  pageObservations?: readonly PdfPageObservation[];
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
    const observations = options.pageObservations;
    const observationsJson =
      observations === undefined ? undefined : JSON.stringify(observations);
    if (
      observationsJson !== undefined &&
      new TextEncoder().encode(observationsJson).byteLength >
        PDF_MAX_OBSERVATION_JSON_BYTES
    ) {
      throw new PdfInspectionError(
        PDF_INSPECTION_ERROR_CODES.observationLimitExceeded,
        `observation-limit-exceeded: PDF observation JSON must not exceed ${PDF_MAX_OBSERVATION_JSON_BYTES} UTF-8 bytes`,
      );
    }
    return JSON.parse(inspect(document, observationsJson)) as PdfInspection;
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
  PdfPageInspection,
  PdfPageObservation,
  PdfRect,
  PdfRiskInventory,
} from "./types";
