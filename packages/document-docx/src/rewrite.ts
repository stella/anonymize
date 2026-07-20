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

const preflightRewritePlan = (
  rewrites: readonly DocxBlockRewrite[],
): readonly unknown[] => {
  const rewriteCount = rewrites.length;
  if (rewriteCount > DOCX_REWRITE_MAX_BLOCKS) {
    throw new DocxRewriteError(
      DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
      `DOCX rewrites must not contain more than ${DOCX_REWRITE_MAX_BLOCKS} blocks`,
    );
  }
  let replacementCount = 0;
  let estimatedBytes = rewriteCount * 256;
  const serializableRewrites: unknown[] = [];
  for (let rewriteIndex = 0; rewriteIndex < rewriteCount; rewriteIndex += 1) {
    const rewrite = rewrites[rewriteIndex];
    if (rewrite === undefined) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX rewrite plans must not contain sparse blocks",
      );
    }
    if (!Array.isArray(rewrite.replacements)) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.invalidReplacement,
        "DOCX block rewrite replacements must be an array",
      );
    }
    const blockReplacementCount = rewrite.replacements.length;
    replacementCount += blockReplacementCount;
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
      blockReplacementCount * 96;
    const serializableReplacements: unknown[] = [];
    for (
      let replacementIndex = 0;
      replacementIndex < blockReplacementCount;
      replacementIndex += 1
    ) {
      const replacement = rewrite.replacements[replacementIndex];
      if (replacement === undefined) {
        throw new DocxRewriteError(
          DOCX_REWRITE_ERROR_CODES.invalidReplacement,
          "DOCX rewrite plans must not contain sparse replacements",
        );
      }
      const value = replacement.replacement;
      if (typeof value === "string") {
        estimatedBytes += value.length * 6;
      }
      serializableReplacements.push({
        start: typeof replacement.start === "number" ? replacement.start : null,
        end: typeof replacement.end === "number" ? replacement.end : null,
        replacement: typeof value === "string" ? value : null,
      });
    }
    const location = rewrite.location as unknown as Record<string, unknown>;
    const part = location["part"] as Record<string, unknown> | undefined;
    for (const value of [location["type"], part?.["type"], part?.["path"]]) {
      if (typeof value === "string") {
        estimatedBytes += value.length * 6;
      }
    }
    const serializableLocation: Record<string, unknown> = {
      type: typeof location["type"] === "string" ? location["type"] : null,
      part: {
        type: typeof part?.["type"] === "string" ? part["type"] : null,
        path: typeof part?.["path"] === "string" ? part["path"] : null,
      },
      blockIndex:
        typeof location["blockIndex"] === "number"
          ? location["blockIndex"]
          : null,
    };
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
        const serializablePath: Array<number | null> = [];
        for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
          const value = path[pathIndex];
          serializablePath.push(typeof value === "number" ? value : null);
        }
        serializableLocation[key] = serializablePath;
      }
    }
    serializableRewrites.push({
      location: serializableLocation,
      expectedText:
        typeof rewrite.expectedText === "string" ? rewrite.expectedText : null,
      replacements: serializableReplacements,
    });
    if (estimatedBytes > DOCX_UNCOMPRESSED_MAX_BYTES) {
      throw new DocxRewriteError(
        DOCX_REWRITE_ERROR_CODES.rewriteLimitExceeded,
        `DOCX rewrite plans must not exceed ${DOCX_UNCOMPRESSED_MAX_BYTES} estimated serialized bytes`,
      );
    }
  }
  return serializableRewrites;
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
  let serializableRewrites: readonly unknown[];
  try {
    serializableRewrites = preflightRewritePlan(rewrites);
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
    rewritesJson = JSON.stringify(serializableRewrites);
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
