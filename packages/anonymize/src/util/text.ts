/**
 * Shared text utilities for detectors.
 *
 * Extracted from names.ts and deny-list.ts to avoid
 * duplicating regex constants and helper functions.
 */

/** Matches a string that starts with an uppercase letter. */
export const UPPER_START_RE = /^\p{Lu}/u;

/** Matches a string consisting entirely of uppercase letters. */
export const ALL_UPPER_RE = /^\p{Lu}+$/u;

const SENTENCE_END_RE = /[.!?]/;

/**
 * Detect whether a position is at the start of a sentence.
 * Looks backward past whitespace for sentence-ending
 * punctuation (.!?). Position 0 and positions preceded
 * only by whitespace are considered sentence starts.
 */
export const isSentenceStart = (
  text: string,
  pos: number,
): boolean => {
  if (pos === 0) {
    return true;
  }
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i] ?? "")) {
    i--;
  }
  if (i < 0) {
    return true;
  }
  return SENTENCE_END_RE.test(text[i] ?? "");
};
