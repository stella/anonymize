import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  DOCX_EXTRACTION_ERROR_CODES,
  DOCX_REWRITE_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxExtractionErrorCode,
  type DocxRewriteErrorCode,
  type DocxRewriteResult,
} from "./types";
import { DocxExtractionError } from "./extract";

export class DocxRewriteError extends Error {
  readonly code: DocxRewriteErrorCode;

  constructor(code: DocxRewriteErrorCode, message: string) {
    super(message);
    this.name = "DocxRewriteError";
    this.code = code;
  }
}

const REWRITE_ERROR_CODES = new Set<DocxRewriteErrorCode>(
  Object.values(DOCX_REWRITE_ERROR_CODES),
);
const EXTRACTION_ERROR_CODES = new Set<DocxExtractionErrorCode>(
  Object.values(DOCX_EXTRACTION_ERROR_CODES),
);

export const rewriteDocxText = (
  archive: Uint8Array,
  rewrites: readonly DocxBlockRewrite[],
): DocxRewriteResult => {
  const rewrite = loadNativeAnonymizeBinding().rewriteDocxTextNative;
  if (rewrite === undefined) {
    throw new Error(
      "The native anonymize binding does not expose DOCX rewriting",
    );
  }
  try {
    return rewrite(archive, JSON.stringify(rewrites));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const separator = message.indexOf(": ");
    const rawCode = message.slice(0, separator);
    const extractionCode = rawCode as DocxExtractionErrorCode;
    if (separator > 0 && EXTRACTION_ERROR_CODES.has(extractionCode)) {
      throw new DocxExtractionError(
        extractionCode,
        message.slice(separator + 2),
      );
    }
    const code = rawCode as DocxRewriteErrorCode;
    if (separator > 0 && REWRITE_ERROR_CODES.has(code)) {
      throw new DocxRewriteError(code, message.slice(separator + 2));
    }
    throw error;
  }
};
