import type {
  NativeCallerDetection,
  NativeOperatorConfig,
  NativeSessionBlockRedactionPlan,
  NativeSessionCallerRedactionPlanOptions,
} from "@stll/anonymize";

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

export const DOCX_COVERAGE_MODES = {
  allowPartial: "allow-partial",
  requireFull: "require-full",
} as const;

export type DocxCoverageMode =
  (typeof DOCX_COVERAGE_MODES)[keyof typeof DOCX_COVERAGE_MODES];

export type DocxCoveragePolicy =
  | { mode: typeof DOCX_COVERAGE_MODES.requireFull }
  | { mode: typeof DOCX_COVERAGE_MODES.allowPartial };

export type DocxAnonymizationPolicy = {
  coverage: DocxCoveragePolicy;
  operators?: NativeOperatorConfig;
};

export type DocxCallerDetection = NativeCallerDetection;

export type DocxBlockCallerDetections = {
  location: DocxBlockLocation;
  expectedText: string;
  detections: readonly DocxCallerDetection[];
};

export type DocxSessionRedactionPlan = {
  blocks: readonly NativeSessionBlockRedactionPlan[];
  commit: () => void;
};

export type DocxAnonymizationSession = {
  sessionId: () => string;
  planTextBatchWithCallerDetections: (
    options: NativeSessionCallerRedactionPlanOptions,
  ) => DocxSessionRedactionPlan;
};

export type AnonymizeDocxOptions = {
  document: Uint8Array;
  session: DocxAnonymizationSession;
  expectedSessionId: string;
  policy: DocxAnonymizationPolicy;
  callerDetections?: readonly DocxBlockCallerDetections[];
  observedAtEpochSeconds?: number;
};

export type DocxCoverageSummary = {
  extractedPartCount: number;
  unsupportedPartCount: number;
  hyperlinkTextSegmentCount: number;
  revisionTextSegmentCount: number;
  unsupportedAlternateContentCount: number;
  unsupportedSymbolCount: number;
  unsupportedFieldInstructionCount: number;
};

export type DocxWorkflowCoverage =
  | { status: "full"; counts: DocxCoverageSummary }
  | { status: "partial"; counts: DocxCoverageSummary };

export type DocxAnonymizationSummary = {
  contractVersion: 1;
  sessionId: string;
  blockCount: number;
  rewrittenBlockCount: number;
  appliedReplacementCount: number;
  entityCount: number;
  callerDetectionCount: number;
  retainedCallerDetectionCount: number;
  coverage: DocxWorkflowCoverage;
};

export type DocxAnonymizationResult = {
  document: Uint8Array;
  summary: DocxAnonymizationSummary;
};

export const DOCX_ANONYMIZATION_ERROR_CODES = {
  incompleteCoverage: "incomplete-coverage",
  invalidCallerDetections: "invalid-caller-detections",
  sessionMismatch: "session-mismatch",
} as const;

export type DocxAnonymizationErrorCode =
  (typeof DOCX_ANONYMIZATION_ERROR_CODES)[keyof typeof DOCX_ANONYMIZATION_ERROR_CODES];

export type DocxRestorationSession = {
  sessionId: () => string;
  restoreText: (text: string, observedAtEpochSeconds?: number) => string;
};

export type RestoreDocxTextOptions = {
  document: Uint8Array;
  session: DocxRestorationSession;
  expectedSessionId: string;
  observedAtEpochSeconds?: number;
};

export type DocxRestorationResult = {
  document: Uint8Array;
  sessionId: string;
  restoredBlockCount: number;
  restoredPlaceholderCount: number;
  coverage: DocxWorkflowCoverage;
};

export const DOCX_RESTORATION_ERROR_CODES = {
  invalidPlaceholder: "invalid-placeholder",
  invalidSession: "invalid-session",
  restorationLimitExceeded: "restoration-limit-exceeded",
  sessionMismatch: "session-mismatch",
} as const;

export type DocxRestorationErrorCode =
  (typeof DOCX_RESTORATION_ERROR_CODES)[keyof typeof DOCX_RESTORATION_ERROR_CODES];

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
