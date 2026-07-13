export const DOCX_PART_TYPES = {
  comments: "comments",
  endnotes: "endnotes",
  footer: "footer",
  footnotes: "footnotes",
  header: "header",
  mainDocument: "main-document",
} as const;

export type DocxPartType =
  (typeof DOCX_PART_TYPES)[keyof typeof DOCX_PART_TYPES];

export type DocxPart = {
  type: DocxPartType;
  path: string;
};

type DocxBaseBlockLocation = {
  part: DocxPart;
  blockIndex: number;
  xmlPath: readonly number[];
};

export type DocxBlockLocation =
  | (DocxBaseBlockLocation & {
      type: "paragraph";
    })
  | (DocxBaseBlockLocation & {
      type: "table-cell-paragraph";
      tablePath: readonly number[];
      rowPath: readonly number[];
      cellPath: readonly number[];
    })
  | (DocxBaseBlockLocation & {
      type: "text-box-paragraph";
      textBoxPath: readonly number[];
    });

export type DocxInlineContext =
  | {
      type: "hyperlink";
      relationshipId: string | null;
      anchor: string | null;
    }
  | {
      type: "revision";
      revision: "deletion" | "insertion" | "move-from" | "move-to";
    };

export type DocxTextSegment = {
  start: number;
  end: number;
  source: "break" | "tab" | "text";
  contexts: readonly DocxInlineContext[];
  xmlPath: readonly number[];
};

export type DocxTextBlock = {
  text: string;
  location: DocxBlockLocation;
  segments: readonly DocxTextSegment[];
};

export type DocxCoverageItem =
  | {
      status: "extracted";
      part: DocxPart;
      blockCount: number;
    }
  | {
      status: "unsupported";
      path: string;
      contentType: string;
      reason: string;
    };

export type DocxCoverage = {
  parts: readonly DocxCoverageItem[];
  hyperlinkTextSegmentCount: number;
  revisionTextSegmentCount: number;
  unsupportedAlternateContentCount: number;
  unsupportedSymbolCount: number;
  unsupportedFieldInstructionCount: number;
};

export type DocxExtraction = {
  contractVersion: 1;
  blocks: readonly DocxTextBlock[];
  coverage: DocxCoverage;
};

export type DocxTextReplacement = {
  start: number;
  end: number;
  replacement: string;
};

export type DocxBlockRewrite = {
  location: DocxBlockLocation;
  expectedText: string;
  replacements: readonly DocxTextReplacement[];
};

export type DocxRewriteResult = {
  document: Uint8Array;
  rewrittenBlockCount: number;
  appliedReplacementCount: number;
};

export const DOCX_REWRITE_ERROR_CODES = {
  invalidReplacement: "invalid-replacement",
  rewriteLimitExceeded: "rewrite-limit-exceeded",
  staleExtraction: "stale-extraction",
  unsupportedReplacement: "unsupported-replacement",
} as const;

export type DocxRewriteErrorCode =
  (typeof DOCX_REWRITE_ERROR_CODES)[keyof typeof DOCX_REWRITE_ERROR_CODES];

export const DOCX_EXTRACTION_ERROR_CODES = {
  archiveLimitExceeded: "archive-limit-exceeded",
  invalidArchive: "invalid-archive",
  invalidPackage: "invalid-package",
  invalidXml: "invalid-xml",
  unsafeEntryPath: "unsafe-entry-path",
  uncompressedLimitExceeded: "uncompressed-limit-exceeded",
} as const;

export type DocxExtractionErrorCode =
  (typeof DOCX_EXTRACTION_ERROR_CODES)[keyof typeof DOCX_EXTRACTION_ERROR_CODES];
