import { extractDocxText } from "./extract";
import { rewriteDocxText } from "./rewrite";
import {
  DOCX_RESTORATION_ERROR_CODES,
  type DocxBlockRewrite,
  type DocxRestorationErrorCode,
  type DocxRestorationResult,
  type DocxTextReplacement,
  type RestoreDocxTextOptions,
} from "./types";

const DOCX_RESTORE_MAX_PLACEHOLDER_UTF16 = 512;
const DOCX_RESTORE_MAX_CANDIDATES = 1_000_000;

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

const encodedSessionNamespace = (sessionId: string): string =>
  sessionId.replaceAll("_", "%5F");

const looksLikeOwnedPlaceholder = (
  value: string,
  encodedSessionId: string,
): boolean => {
  const marker = `_${encodedSessionId}_`;
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return false;
  }
  const countStart = markerIndex + marker.length;
  const countEnd = value.endsWith("]") ? -1 : undefined;
  const count = value.slice(countStart, countEnd);
  return count.length > 0 && /^\d+$/u.test(count);
};

type PlanBlockRestorationOptions = {
  text: string;
  encodedSessionId: string;
  restoreCandidate: (candidate: string) => string;
  budget: { candidateCount: number };
};

const planBlockRestoration = ({
  text,
  encodedSessionId,
  restoreCandidate,
  budget,
}: PlanBlockRestorationOptions): DocxTextReplacement[] => {
  const replacements: DocxTextReplacement[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("[", cursor);
    if (start === -1) {
      break;
    }
    const nextOpen = text.indexOf("[", start + 1);
    const end = text.indexOf("]", start + 1);
    if (nextOpen !== -1 && (end === -1 || nextOpen < end)) {
      cursor = start + 1;
      continue;
    }
    if (end === -1) {
      const remainder = text.slice(start + 1);
      if (looksLikeOwnedPlaceholder(remainder, encodedSessionId)) {
        throw restorationError(
          DOCX_RESTORATION_ERROR_CODES.invalidPlaceholder,
          "DOCX text contains an incomplete placeholder for the expected session",
        );
      }
      break;
    }
    const candidateEnd = end + 1;
    const candidate = text.slice(start, candidateEnd);
    budget.candidateCount += 1;
    if (budget.candidateCount > DOCX_RESTORE_MAX_CANDIDATES) {
      throw restorationError(
        DOCX_RESTORATION_ERROR_CODES.restorationLimitExceeded,
        `DOCX restoration must not inspect more than ${DOCX_RESTORE_MAX_CANDIDATES} placeholder candidates`,
      );
    }
    if (candidate.length > DOCX_RESTORE_MAX_PLACEHOLDER_UTF16) {
      if (looksLikeOwnedPlaceholder(candidate.slice(1), encodedSessionId)) {
        throw restorationError(
          DOCX_RESTORATION_ERROR_CODES.invalidPlaceholder,
          "DOCX session placeholder exceeds the maximum length",
        );
      }
      cursor = candidateEnd;
      continue;
    }
    const replacement = restoreCandidate(candidate);
    if (replacement !== candidate) {
      replacements.push({ start, end: candidateEnd, replacement });
    } else if (
      looksLikeOwnedPlaceholder(candidate.slice(1), encodedSessionId)
    ) {
      throw restorationError(
        DOCX_RESTORATION_ERROR_CODES.invalidPlaceholder,
        "DOCX text contains an unknown placeholder for the expected session",
      );
    }
    cursor = candidateEnd;
  }
  return replacements;
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
  const encodedSessionId = encodedSessionNamespace(sessionId);
  const extraction = extractDocxText(document);
  const rewrites: DocxBlockRewrite[] = [];
  const budget = { candidateCount: 0 };
  let restoredPlaceholderCount = 0;
  for (const block of extraction.blocks) {
    const replacements = planBlockRestoration({
      text: block.text,
      encodedSessionId,
      restoreCandidate,
      budget,
    });
    if (replacements.length === 0) {
      continue;
    }
    restoredPlaceholderCount += replacements.length;
    rewrites.push({
      location: block.location,
      expectedText: block.text,
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
  };
};
