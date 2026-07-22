export type PdfRect = {
  left: number;
  bottom: number;
  right: number;
  top: number;
};

export type PdfGlyphObservation = {
  start: number;
  end: number;
  /** Bounds in normalized displayed-page PDF points, origin bottom-left. */
  bounds: PdfRect;
  source: "embedded-text" | "ocr";
};

export type PdfPageObservation = {
  pageIndex: number;
  /** Effective visible width after page boxes, rotation, and UserUnit scaling. */
  widthPoints: number;
  /** Effective visible height after page boxes, rotation, and UserUnit scaling. */
  heightPoints: number;
  text: string;
  glyphs: readonly PdfGlyphObservation[];
  rendered: boolean;
  textLayer: "absent" | "partial" | "complete";
  ocr: "not-run" | "partial" | "complete";
  imageCount: number;
};

export type PdfRiskInventory = {
  acroFormFieldCount: number;
  annotationCount: number;
  documentInfoEntryCount: number;
  embeddedFileCount: number;
  externalActionCount: number;
  formXObjectCount: number;
  imageObjectCount: number;
  incrementalRevisionCount: number;
  javascriptActionCount: number;
  metadataStreamCount: number;
  optionalContentGroupCount: number;
  signatureCount: number;
  trailingNonWhitespaceByteCount: number;
  unsupportedActionCount: number;
  xfaEntryCount: number;
};

export type PdfInspectionGap =
  | "encrypted-document"
  | "page-content-not-observed"
  | "page-not-rendered"
  | "partial-text-layer"
  | "retained-document-bytes"
  | "unobserved-visual-content";

export type PdfPageInspection = {
  pageIndex: number;
  annotationCount: number;
  observation: PdfPageObservation | null;
};

export type PdfInspection = {
  contractVersion: 1;
  pdfVersion: string;
  byteLength: number;
  objectCount: number;
  pageCount: number;
  encrypted: boolean;
  pages: readonly PdfPageInspection[];
  risks: PdfRiskInventory;
  coverage: {
    status: "full" | "partial";
    gaps: readonly PdfInspectionGap[];
  };
};

export type PdfRasterProvider = {
  providerId: string;
  rendererName: string;
  rendererVersion: string;
  ocrName: string;
  ocrVersion: string;
  /** One explicit provider language pack; never an implicit mixed-language set. */
  ocrLanguage: string;
};

export type PdfRasterPage = {
  observation: PdfPageObservation;
  widthPixels: number;
  heightPixels: number;
  /** Lowercase SHA-256 of this page's exact opaque, row-packed RGB8 bytes. */
  pixelSha256: string;
  /** Strictly ordered, non-overlapping UTF-16 spans. */
  detections: readonly PdfRasterDetection[];
};

export type PdfRasterDetection = { start: number; end: number };

export type PdfRasterRewrite = {
  contractVersion: 1;
  /** Lowercase SHA-256 of the exact source PDF bytes supplied to the call. */
  sourceSha256: string;
  provider: PdfRasterProvider;
  fillRgb: readonly [number, number, number];
  pages: readonly PdfRasterPage[];
};

export type PdfRasterRewriteCertificate = {
  contractVersion: 1;
  pageCount: number;
  sourceSha256: string;
  outputSha256: string;
  provider: PdfRasterProvider;
  detectionCount: number;
  mappedRegionCount: number;
  structurePixelRewriteVerified: true;
  providerAssertedCoverage: "complete-rendering-and-ocr-observation";
  piiCleanGuaranteed: false;
  limitation: string;
};

export type PdfRasterRewriteResult = {
  document: Uint8Array;
  certificate: PdfRasterRewriteCertificate;
};

export const PDF_INSPECTION_ERROR_CODES = {
  documentLimitExceeded: "document-limit-exceeded",
  invalidDocument: "invalid-document",
  invalidObservation: "invalid-observation",
  observationLimitExceeded: "observation-limit-exceeded",
  providerFailed: "provider-failed",
} as const;

export type PdfInspectionErrorCode =
  (typeof PDF_INSPECTION_ERROR_CODES)[keyof typeof PDF_INSPECTION_ERROR_CODES];

export const PDF_RASTER_ERROR_CODES = {
  detectionFailed: "detection-failed",
  invalidContract: "invalid-contract",
  limitExceeded: "limit-exceeded",
  sourceRejected: "source-rejected",
  verificationFailed: "verification-failed",
} as const;

export type PdfRasterErrorCode =
  (typeof PDF_RASTER_ERROR_CODES)[keyof typeof PDF_RASTER_ERROR_CODES];
