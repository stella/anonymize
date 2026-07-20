import { loadNativeAnonymizeBinding } from "@stll/anonymize";

import { docxWorkflowCoverage } from "./coverage";
import { rewriteDocxText } from "./rewrite";
import {
  DOCX_RESTORATION_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxRestorationErrorCode,
  type DocxRestorationResult,
  type DocxTextReplacement,
  type RestoreDocxTextOptions,
} from "./types";

export class DocxRestorationError extends Error {
  readonly code: DocxRestorationErrorCode;

  constructor(code: DocxRestorationErrorCode, message: string) {
    super(message);
    this.name = "DocxRestorationError";
    this.code = code;
  }
}

const restorationError = (
  code: DocxRestorationErrorCode,
  message: string,
): DocxRestorationError => new DocxRestorationError(code, message);

type NativeRestorationPlan = {
  extraction: {
    coverage: Parameters<typeof docxWorkflowCoverage>[0];
  };
  blocks: readonly {
    location: DocxBlockRewrite["location"];
    expectedText: string;
    candidates: readonly {
      start: number;
      end: number;
      candidate: string;
    }[];
  }[];
};

export const restoreDocxText = ({
  document,
  session,
  expectedSessionId,
  observedAtEpochSeconds,
}: RestoreDocxTextOptions): DocxRestorationResult => {
  const sessionId = session.sessionId();
  if (sessionId !== expectedSessionId) {
    throw restorationError(
      DOCX_RESTORATION_ERROR_CODES.sessionMismatch,
      "DOCX restoration session does not match the expected session id",
    );
  }

  const assertSessionAvailable = (): void => {
    if (session.restoreText("", observedAtEpochSeconds) !== "") {
      throw restorationError(
        DOCX_RESTORATION_ERROR_CODES.invalidSession,
        "DOCX restoration session must preserve text without placeholders",
      );
    }
  };
  assertSessionAvailable();
  const restoredCandidates = new Map<string, string>();
  const restoreCandidate = (candidate: string): string => {
    const cached = restoredCandidates.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    const restored = session.restoreText(candidate, observedAtEpochSeconds);
    restoredCandidates.set(candidate, restored);
    return restored;
  };
  const planRestoration = loadNativeAnonymizeBinding().planDocxRestorationJson;
  if (planRestoration === undefined) {
    throw restorationError(
      DOCX_RESTORATION_ERROR_CODES.invalidSession,
      "Native anonymize binding does not expose DOCX restoration planning",
    );
  }
  let plan: NativeRestorationPlan;
  try {
    plan = JSON.parse(
      planRestoration(document, sessionId),
    ) as NativeRestorationPlan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("must not inspect more than")
      ? DOCX_RESTORATION_ERROR_CODES.restorationLimitExceeded
      : DOCX_RESTORATION_ERROR_CODES.invalidPlaceholder;
    throw restorationError(code, message);
  }
  const rewrites: DocxBlockRewrite[] = [];
  let restoredPlaceholderCount = 0;
  for (const block of plan.blocks) {
    const replacements: DocxTextReplacement[] = block.candidates.map(
      ({ candidate, end, start }) => {
        const replacement = restoreCandidate(candidate);
        if (replacement === candidate) {
          throw restorationError(
            DOCX_RESTORATION_ERROR_CODES.invalidPlaceholder,
            "DOCX text contains an unknown placeholder for the expected session",
          );
        }
        return { start, end, replacement };
      },
    );
    if (replacements.length === 0) {
      continue;
    }
    restoredPlaceholderCount += replacements.length;
    rewrites.push({
      location: block.location,
      expectedText: block.expectedText,
      replacements,
    });
  }
  assertSessionAvailable();
  const restored = rewriteDocxText(document, rewrites);
  return {
    document: restored.document,
    sessionId,
    restoredBlockCount: restored.rewrittenBlockCount,
    restoredPlaceholderCount,
    coverage: docxWorkflowCoverage(plan.extraction.coverage),
  };
};
