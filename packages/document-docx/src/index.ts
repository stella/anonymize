export {
  DOCX_ARCHIVE_MAX_BYTES,
  DOCX_ENTRY_MAX_BYTES,
  DOCX_EXTRACTION_CONTRACT_VERSION,
  DOCX_UNCOMPRESSED_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
  extractDocxText,
} from "./extract";
export { DocxRewriteError, rewriteDocxText } from "./rewrite";
export { DocxRestorationError, restoreDocxText } from "./restore";
export {
  DOCX_EXTRACTION_ERROR_CODES,
  DOCX_PART_TYPES,
  DOCX_RESTORATION_ERROR_CODES,
  DOCX_REWRITE_ERROR_CODES,
} from "./types";
export type {
  DocxBlockRewrite,
  DocxBlockLocation,
  DocxCoverage,
  DocxCoverageItem,
  DocxExtraction,
  DocxExtractionErrorCode,
  DocxInlineContext,
  DocxPart,
  DocxRestorationErrorCode,
  DocxRestorationResult,
  DocxRestorationSession,
  DocxRewriteErrorCode,
  DocxRewriteResult,
  DocxTextReplacement,
  DocxTextBlock,
  DocxTextSegment,
  RestoreDocxTextOptions,
} from "./types";
