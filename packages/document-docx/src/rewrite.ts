import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  DOCX_REWRITE_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxRewriteErrorCode,
  type DocxRewriteResult,
} from "./types";

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
    const code = message.slice(0, separator) as DocxRewriteErrorCode;
    if (separator > 0 && REWRITE_ERROR_CODES.has(code)) {
      throw new DocxRewriteError(code, message.slice(separator + 2));
    }
    throw error;
  }
};
