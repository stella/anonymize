export {
  DOCX_ARCHIVE_MAX_BYTES,
  DOCX_ENTRY_MAX_BYTES,
  DOCX_EXTRACTION_CONTRACT_VERSION,
  DOCX_UNCOMPRESSED_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
  extractDocxText,
} from "./extract";
export type {
  DocxBlockLocation,
  DocxCoverage,
  DocxCoverageItem,
  DocxExtraction,
  DocxExtractionErrorCode,
  DocxInlineContext,
  DocxPart,
  DocxTextBlock,
  DocxTextSegment,
} from "./types";
