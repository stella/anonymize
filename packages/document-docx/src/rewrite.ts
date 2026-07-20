import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import {
  DOCX_EXTRACTION_ERROR_CODES,
  DOCX_REWRITE_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxExtractionErrorCode,
  type DocxRewriteErrorCode,
  type DocxRewriteResult,
} from "./types";
import {
  DOCX_UNCOMPRESSED_MAX_BYTES,
  DOCX_XML_MAX_DEPTH,
  DocxExtractionError,
} from "./extract";

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
const DOCX_REWRITE_MAX_BLOCKS = 100_000;
const DOCX_REWRITE_MAX_REPLACEMENTS = 1_000_000;
const LOCATION_PATH_KEYS = [
  "xmlPath",
  "tablePath",
  "rowPath",
  "cellPath",
  "textBoxPath",
] as const;
const REWRITE_JSON_FIELDS = [
  "location",
  "expectedText",
  "replacements",
  "start",
  "end",
  "replacement",
  "type",
  "part",
  "path",
  "blockIndex",
  ...LOCATION_PATH_KEYS,
] as const;

const preflightRewritePlan = (rewrites: readonly DocxBlockRewrite[]): void => {
  if (rewrites.length > DOCX_REWRITE_MAX_BLOCKS) {
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `DOCX rewrites must not contain more than ${DOCX_REWRITE_MAX_BLOCKS} blocks`,
    );
  }
  let replacementCount = 0;
  let estimatedBytes = rewrites.length * 256;
  for (const rewrite of rewrites) {
    if (!Array.isArray(rewrite.replacements)) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX block rewrite replacements must be an array",
      );
    }
    replacementCount += rewrite.replacements.length;
    if (replacementCount > DOCX_REWRITE_MAX_REPLACEMENTS) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrites must not contain more than ${DOCX_REWRITE_MAX_REPLACEMENTS} replacements`,
      );
    }
    estimatedBytes +=
      (typeof rewrite.expectedText === "string"
        ? rewrite.expectedText.length * 6
        : 0) +
      rewrite.replacements.length * 96;
    for (const replacement of rewrite.replacements) {
      if (typeof replacement.replacement === "string") {
        estimatedBytes += replacement.replacement.length * 6;
      }
    }
    const location = rewrite.location as unknown as Record<string, unknown>;
    for (const value of [
      location["type"],
      (location["part"] as Record<string, unknown> | undefined)?.["type"],
      (location["part"] as Record<string, unknown> | undefined)?.["path"],
    ]) {
      if (typeof value === "string") {
        estimatedBytes += value.length * 6;
      }
    }
    for (const key of LOCATION_PATH_KEYS) {
      const path = location[key];
      if (Array.isArray(path)) {
        if (path.length > DOCX_XML_MAX_DEPTH) {
          throw new DocxRewriteError(
            DOCX_REWRITE_ERROR_CODES.invalidReplacement,
            `DOCX rewrite location paths must not exceed ${DOCX_XML_MAX_DEPTH} entries`,
          );
        }
        estimatedBytes += path.length * 24;
      }
    }
    if (estimatedBytes > DOCX_UNCOMPRESSED_MAX_BYTES) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrite plans must not exceed ${DOCX_UNCOMPRESSED_MAX_BYTES} estimated serialized bytes`,
      );
    }
  }
};

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
    preflightRewritePlan(rewrites);
  } catch (error) {
    if (error instanceof DocxRewriteError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      `DOCX rewrite plan is invalid: ${message}`,
    );
  }
  let rewritesJson: string;
  try {
    rewritesJson = JSON.stringify(rewrites, [...REWRITE_JSON_FIELDS]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.invalidReplacement,
      `DOCX rewrite plan is not serializable: ${message}`,
    );
  }
  try {
    return rewrite(archive, rewritesJson);
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
