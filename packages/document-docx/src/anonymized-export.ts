import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import { decodeDocxExtraction } from "./native-codec";
import { rewriteDocxText } from "./rewrite";
import {
  DOCX_ANONYMIZED_EXPORT_ERROR_CODES,
  type DocxAnonymizedExportErrorCode,
  type DocxAnonymizedExportReport,
  type DocxAnonymizedExportResult,
  type RewriteDocxForAnonymizedExportOptions,
} from "./types";

const REPORT_FIELDS = [
  "contractVersion",
  "removedPartCount",
  "sanitizedXmlPartCount",
] as const;

const INVALID_DOCUMENT_NATIVE_CODES = new Set([
  "archive-limit-exceeded",
  "invalid-archive",
  "invalid-package",
  "invalid-xml",
  "uncompressed-limit-exceeded",
  "unsafe-entry-path",
]);

export class DocxAnonymizedExportError extends Error {
  readonly code: DocxAnonymizedExportErrorCode;

  constructor(code: DocxAnonymizedExportErrorCode, message: string) {
    super(message);
    this.name = "DocxAnonymizedExportError";
    this.code = code;
  }
}

const exportError = (
  code: DocxAnonymizedExportErrorCode,
  message: string,
): DocxAnonymizedExportError => new DocxAnonymizedExportError(code, message);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeReport = (json: string): DocxAnonymizedExportReport => {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== REPORT_FIELDS.length ||
    !REPORT_FIELDS.every((field) => Object.hasOwn(value, field))
  ) {
    throw new TypeError("Native DOCX export report has an invalid shape");
  }
  if (
    value["contractVersion"] !== 1 ||
    !isNonNegativeInteger(value["removedPartCount"]) ||
    !isNonNegativeInteger(value["sanitizedXmlPartCount"])
  ) {
    throw new TypeError("Native DOCX export report has invalid values");
  }
  return {
    contractVersion: 1,
    removedPartCount: value["removedPartCount"],
    sanitizedXmlPartCount: value["sanitizedXmlPartCount"],
  };
};

const prepare = (document: Uint8Array) => {
  try {
    const nativePrepare =
      loadNativeAnonymizeBinding().prepareDocxAnonymizedExportNative;
    const prepared = nativePrepare(document);
    return {
      document: prepared.document,
      extraction: decodeDocxExtraction(prepared.extractionJson),
      report: decodeReport(prepared.reportJson),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const nativeCode = detail.split(":", 1).at(0);
    if (nativeCode === "unsupported-replacement") {
      throw exportError(
        DOCX_ANONYMIZED_EXPORT_ERROR_CODES.unsupportedDocument,
        "The DOCX contains content unsupported by anonymized export",
      );
    }
    if (
      nativeCode !== undefined &&
      INVALID_DOCUMENT_NATIVE_CODES.has(nativeCode)
    ) {
      throw exportError(
        DOCX_ANONYMIZED_EXPORT_ERROR_CODES.invalidDocument,
        "The DOCX is not a valid document for anonymized export",
      );
    }
    throw exportError(
      DOCX_ANONYMIZED_EXPORT_ERROR_CODES.validationFailed,
      "The anonymized DOCX export could not be prepared",
    );
  }
};

export const rewriteDocxForAnonymizedExport = async ({
  document,
  planRewrites,
}: RewriteDocxForAnonymizedExportOptions): Promise<DocxAnonymizedExportResult> => {
  const prepared = prepare(document);
  const rewrites = await planRewrites(prepared.extraction);
  let rewritten: ReturnType<typeof rewriteDocxText>;
  try {
    rewritten = rewriteDocxText(prepared.document, rewrites);
  } catch {
    throw exportError(
      DOCX_ANONYMIZED_EXPORT_ERROR_CODES.invalidRewritePlan,
      "The DOCX anonymization rewrite plan is invalid",
    );
  }
  let finalizedDocument: Uint8Array;
  try {
    finalizedDocument =
      loadNativeAnonymizeBinding().finalizeDocxAnonymizedExportNative(
        rewritten.document,
      );
  } catch {
    throw exportError(
      DOCX_ANONYMIZED_EXPORT_ERROR_CODES.validationFailed,
      "The anonymized DOCX did not pass export validation",
    );
  }
  return {
    ...rewritten,
    document: finalizedDocument,
    report: prepared.report,
  };
};
