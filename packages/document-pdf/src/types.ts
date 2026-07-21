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

export type PdfObservationProvider = {
  id: string;
  name: string;
  version: string;
};

export type PdfObservationBatch = {
  version: 1;
  document: { sha256: string };
  provider: PdfObservationProvider;
  pages: readonly PdfPageObservation[];
};

export type PdfRiskInventory = {
  acroFormFieldCount: number;
  annotationCount: number;
  documentInfoEntryCount: number;
  embeddedFileCount: number;
  externalActionCount: number;
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
  | "observation-provider-not-identified"
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
  observationProvider: PdfObservationProvider | null;
  pages: readonly PdfPageInspection[];
  risks: PdfRiskInventory;
  coverage: {
    status: "provider-attested-full" | "partial";
    gaps: readonly PdfInspectionGap[];
  };
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
