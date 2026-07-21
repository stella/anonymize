import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  PDF_INSPECTION_ERROR_CODES,
  PDF_RASTER_ERROR_CODES,
  type PdfInspection,
  type PdfInspectionErrorCode,
  type PdfPageObservation,
  type PdfRasterAnonymization,
  type PdfRasterAnonymizationResult,
  type PdfRasterErrorCode,
} from "./types";

export const PDF_INSPECTION_CONTRACT_VERSION = 1 as const;
export const PDF_RASTER_CONTRACT_VERSION = 1 as const;
export const PDF_RASTER_MAX_PAGE_BYTES = 128 * 1024 * 1024;
export const PDF_RASTER_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const PDF_RASTER_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
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

export class PdfRasterError extends Error {
  readonly code: PdfRasterErrorCode;

  constructor(code: PdfRasterErrorCode, message: string) {
    super(message);
    this.name = "PdfRasterError";
    this.code = code;
  }
}

const errorCode = (message: string): PdfInspectionErrorCode => {
  const code = Object.values(PDF_INSPECTION_ERROR_CODES).find((candidate) =>
    message.startsWith(`${candidate}:`),
  );
  return code ?? PDF_INSPECTION_ERROR_CODES.invalidDocument;
};

const rasterErrorCode = (message: string): PdfRasterErrorCode => {
  const code = Object.values(PDF_RASTER_ERROR_CODES).find((candidate) =>
    message.startsWith(`${candidate}:`),
  );
  return code ?? PDF_RASTER_ERROR_CODES.verificationFailed;
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

export type AnonymizePdfRasterOptions = {
  document: Uint8Array;
  request: PdfRasterAnonymization;
  /** One opaque, row-packed RGB8 buffer per request page, in page order. */
  pagePixels: readonly Uint8Array[];
};

/**
 * Destructively fills provider-asserted raster regions and emits a brand-new image-only
 * PDF. The provider, not this function, owns rendering, OCR, and detection.
 */
export const anonymizePdfRaster = ({
  document,
  request,
  pagePixels,
}: AnonymizePdfRasterOptions): PdfRasterAnonymizationResult => {
  const anonymize = loadNativeAnonymizeBinding().anonymizePdfRasterJson;
  if (anonymize === undefined) {
    throw new PdfRasterError(
      PDF_RASTER_ERROR_CODES.verificationFailed,
      "Native anonymize binding does not expose PDF raster anonymization",
    );
  }
  try {
    const result = anonymize(document, JSON.stringify(request), pagePixels);
    return {
      document: result.document,
      certificate: JSON.parse(result.certificateJson),
    } as PdfRasterAnonymizationResult;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "PDF raster anonymization failed";
    throw new PdfRasterError(rasterErrorCode(message), message);
  }
};

export { PDF_INSPECTION_ERROR_CODES } from "./types";
export { PDF_RASTER_ERROR_CODES } from "./types";
export type {
  PdfGlyphObservation,
  PdfInspection,
  PdfInspectionErrorCode,
  PdfInspectionGap,
  PdfPageInspection,
  PdfPageObservation,
  PdfRect,
  PdfRiskInventory,
  PdfRasterAnonymization,
  PdfRasterAnonymizationResult,
  PdfRasterCertificate,
  PdfRasterErrorCode,
  PdfRasterPage,
  PdfRasterProvider,
} from "./types";
