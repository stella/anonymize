import { sha256Hex } from "./hash";
import { verdictsPath } from "./paths";
import {
  CORPUS_SOURCES,
  SPAN_VERDICTS,
  type VerdictsFile,
  type VerdictSpan,
} from "./types";

/** Key spans by position and label; offsets are stable per content hash. */
export const spanKey = ({
  start,
  end,
  label,
}: {
  start: number;
  end: number;
  label: string;
}): string => `${start}:${end}:${label}`;

export const loadVerdictsForDoc = async (
  sha256: string,
): Promise<VerdictsFile | null> => {
  for (const source of CORPUS_SOURCES) {
    const file = Bun.file(verdictsPath(source, sha256));
    if (await file.exists()) {
      // SAFETY: verdict files are validated against the document
      // text via validateVerdicts before their spans are used.
      return (await file.json()) as VerdictsFile;
    }
  }
  return null;
};

/**
 * Judged span keyed by position+label. The full span (not just the
 * verdict) is kept so the differ can report verdict-derived findings
 * with their text: a `tp` missing from the current run is a regression
 * even when no baseline run is given. When the same key has
 * conflicting verdicts the last one wins.
 */
export const judgedVerdictsByKey = (
  verdicts: VerdictsFile | null,
): ReadonlyMap<string, VerdictSpan> => {
  const byKey = new Map<string, VerdictSpan>();
  for (const span of verdicts?.spans ?? []) {
    byKey.set(spanKey(span), span);
  }
  return byKey;
};

export type VerdictIssue = {
  spanIndex: number;
  message: string;
};

const validateSpan = (span: VerdictSpan, text: string): string | null => {
  if (!SPAN_VERDICTS.includes(span.verdict)) {
    return `unknown verdict "${span.verdict}"`;
  }
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end > text.length ||
    span.start >= span.end
  ) {
    return `invalid offsets [${span.start}, ${span.end}) for document of length ${text.length}`;
  }
  const actual = text.slice(span.start, span.end);
  if (actual !== span.value) {
    // Case-law verdict files quote personal data and stay gitignored, yet
    // diff.ts prints these messages to stderr. Never echo the verbatim span
    // or document slice; report lengths and short content hashes so a
    // mismatch stays locatable without leaking the underlying text.
    return `value mismatch at [${span.start}, ${span.end}): expected ${span.value.length} chars (sha ${sha256Hex(span.value).slice(0, 8)}), document has ${actual.length} chars (sha ${sha256Hex(actual).slice(0, 8)})`;
  }
  return null;
};

/**
 * Mechanical validation: every judged span must quote the
 * document verbatim at its offsets. Returns all issues so a
 * broken verdict file is fixed in one pass.
 */
export const validateVerdicts = ({
  verdicts,
  text,
}: {
  verdicts: VerdictsFile;
  text: string;
}): VerdictIssue[] => {
  const issues: VerdictIssue[] = [];
  verdicts.spans.forEach((span, spanIndex) => {
    const message = validateSpan(span, text);
    if (message !== null) {
      issues.push({ spanIndex, message });
    }
  });
  return issues;
};
