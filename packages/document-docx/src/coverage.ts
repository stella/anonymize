import type { DocxCoverage, DocxWorkflowCoverage } from "./types";

const hasPartialCoverage = (coverage: DocxCoverage): boolean =>
  coverage.parts.some(({ status }) => status === "unsupported") ||
  coverage.hyperlinkTextSegmentCount > 0 ||
  coverage.revisionTextSegmentCount > 0 ||
  coverage.unsupportedAlternateContentCount > 0 ||
  coverage.unsupportedSymbolCount > 0 ||
  coverage.unsupportedFieldInstructionCount > 0;

export const docxWorkflowCoverage = (
  coverage: DocxCoverage,
): DocxWorkflowCoverage => {
  const counts = {
    extractedPartCount: coverage.parts.filter(
      ({ status }) => status === "extracted",
    ).length,
    unsupportedPartCount: coverage.parts.filter(
      ({ status }) => status === "unsupported",
    ).length,
    hyperlinkTextSegmentCount: coverage.hyperlinkTextSegmentCount,
    revisionTextSegmentCount: coverage.revisionTextSegmentCount,
    unsupportedAlternateContentCount: coverage.unsupportedAlternateContentCount,
    unsupportedSymbolCount: coverage.unsupportedSymbolCount,
    unsupportedFieldInstructionCount: coverage.unsupportedFieldInstructionCount,
  };
  return hasPartialCoverage(coverage)
    ? { status: "partial", counts }
    : { status: "full", counts };
};
