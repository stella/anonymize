import type { Entity } from "../types";
import { DETECTION_SOURCES } from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";

/*
 * Signature-block detector.
 *
 * Recognises the stereotyped shape of legal-document
 * signature blocks and emits high-confidence person
 * spans for the signatory name. Anchors we trust:
 *
 *   • "/s/" — the canonical "in lieu of physical
 *     signature" mark used across SEC and EDGAR
 *     filings. Whatever follows on the same line (or,
 *     when the mark is on its own line, the next
 *     non-empty line) is the signer's printed name.
 *
 *   • "Name:" / "By:" labels — explicitly-labelled
 *     signature fields ("Name: Elon R. Musk",
 *     "By: /s/ Elon R. Musk"). The value of the field
 *     is the signer.
 *
 *   • "IN WITNESS WHEREOF" — the standard preamble
 *     introducing a signature block. The next short
 *     name-shaped line that isn't an image stub or a
 *     boilerplate phrase is the signer.
 *
 * The detector emits with source TRIGGER (priority 4)
 * so signature-anchored detections outrank deny-list
 * heuristics that may otherwise mis-classify part of
 * the name ("Sean D Reilly" — deny-list previously
 * caught only "Reilly").
 */

const SLASH_S_RE = /\/s\/[ \t]*/g;
const LABELLED_NAME_RE =
  /(?:^|\n)[ \t]*(?:By|Name)[ \t]*:[ \t]*(?:\/s\/[ \t]+)?([^\n]*)/gi;
const WITNESS_ANCHOR_RE = /\bIN WITNESS WHEREOF\b[^\n]*\n/g;

// A name shape: 1–4 cap-or-allcap tokens, no digits.
// Allows interior dots (middle initials, "J.P."),
// apostrophes, and hyphens. The {0,3} bound caps
// the chain so generic captions like "President,
// Secretary and Treasurer" don't qualify (they have
// commas / lowercase connectors).
const NAME_SHAPE_RE =
  /^(?:\p{Lu}[\p{L}\p{M}.'\-]{0,30})(?:[ \t]+\p{Lu}[\p{L}\p{M}.'\-]{0,30}){0,3}$/u;
const MAX_NAME_LEN = 60;

// Lines that look like image stubs or section markers
// — skip them when walking forward from a witness
// anchor.
const IMAGE_STUB_RE = /^(?:\[?img|\[image|\[logo|\(logo\))/i;

const isNameShape = (text: string): boolean => {
  if (text.length === 0 || text.length > MAX_NAME_LEN) return false;
  if (!NAME_SHAPE_RE.test(text)) return false;
  // Reject candidates that are entirely a single
  // common-noun token like "Name" or "By" that slipped
  // past — they have no whitespace and a short length.
  return text.length >= 3;
};

const findLineEnd = (text: string, pos: number): number => {
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
};

const emitNameAt = (
  results: Entity[],
  fullText: string,
  start: number,
  end: number,
  score: number,
): void => {
  const text = fullText.slice(start, end).trim();
  if (!isNameShape(text)) return;
  // Re-locate the trimmed span inside the slice so
  // the entity coordinates stay tight.
  const offset = fullText.slice(start, end).indexOf(text);
  if (offset < 0) return;
  const absStart = start + offset;
  results.push({
    start: absStart,
    end: absStart + text.length,
    label: "person",
    text,
    score,
    source: DETECTION_SOURCES.TRIGGER,
  });
};

const walkToNextNameLine = (
  fullText: string,
  fromPos: number,
  maxLines: number,
): { lineStart: number; lineEnd: number } | null => {
  let pos = fromPos;
  for (let i = 0; i < maxLines; i++) {
    if (pos >= fullText.length) return null;
    const lineEnd = findLineEnd(fullText, pos);
    const line = fullText.slice(pos, lineEnd).trim();
    if (line.length > 0 && !IMAGE_STUB_RE.test(line)) {
      return { lineStart: pos, lineEnd };
    }
    pos = lineEnd + 1;
  }
  return null;
};

const findPrevLine = (
  fullText: string,
  pos: number,
): { lineStart: number; lineEnd: number } | null => {
  // Scan backwards past the current line, then past any
  // empty lines, to the first non-empty line above.
  let cursor = pos - 1;
  // skip trailing newlines/whitespace on the current line
  while (cursor >= 0 && fullText.charAt(cursor) !== "\n") cursor--;
  // cursor is at the newline ending the previous line
  while (cursor >= 0) {
    let lineStart = cursor;
    while (lineStart > 0 && fullText.charAt(lineStart - 1) !== "\n") {
      lineStart -= 1;
    }
    const lineEnd = cursor;
    const line = fullText.slice(lineStart, lineEnd).trim();
    if (line.length > 0 && !IMAGE_STUB_RE.test(line)) {
      return { lineStart, lineEnd };
    }
    cursor = lineStart - 1;
  }
  return null;
};

export const detectSignatures = (
  fullText: string,
  _ctx: PipelineContext = defaultContext,
): Entity[] => {
  const results: Entity[] = [];

  // Pass 1: `/s/` marks.
  SLASH_S_RE.lastIndex = 0;
  for (
    let m = SLASH_S_RE.exec(fullText);
    m !== null;
    m = SLASH_S_RE.exec(fullText)
  ) {
    const afterMark = m.index + m[0].length;
    const lineEnd = findLineEnd(fullText, afterMark);
    const sameLine = fullText.slice(afterMark, lineEnd).trim();
    if (sameLine.length > 0) {
      emitNameAt(results, fullText, afterMark, lineEnd, 0.95);
    } else {
      // Mark sits at end of line — the printed name
      // typically appears on the next non-empty line.
      const next = walkToNextNameLine(fullText, lineEnd + 1, 4);
      if (next) {
        emitNameAt(results, fullText, next.lineStart, next.lineEnd, 0.9);
      }
    }

    // Also look at the previous non-empty line. EDGAR
    // documents often print the signatory's name in
    // ALL CAPS immediately above the "/s/" mark
    // ("ELON R. MUSK\n/s/ Elon R. Musk"). Without this
    // pass the caps version survives unredacted.
    const prev = findPrevLine(fullText, m.index);
    if (prev) {
      emitNameAt(results, fullText, prev.lineStart, prev.lineEnd, 0.85);
    }
  }

  // Pass 2: "Name:" / "By:" labels.
  LABELLED_NAME_RE.lastIndex = 0;
  for (
    let m = LABELLED_NAME_RE.exec(fullText);
    m !== null;
    m = LABELLED_NAME_RE.exec(fullText)
  ) {
    const value = m[1];
    if (value === undefined) continue;
    const valueStart = m.index + m[0].length - value.length;
    const valueEnd = valueStart + value.length;
    emitNameAt(results, fullText, valueStart, valueEnd, 0.95);
  }

  // Pass 3: "IN WITNESS WHEREOF" preamble — walk
  // forward past the preamble sentence and find the
  // next name-shaped line. Useful when the "/s/" mark
  // is hidden inside an image reference (common in
  // EDGAR HTML exports of certificates with embedded
  // signature graphics). To avoid catching tokens
  // inside the preamble itself ("Effective Date." in
  // "as of the Effective Date."), wait for the sentence
  // terminator before scanning for names.
  WITNESS_ANCHOR_RE.lastIndex = 0;
  for (
    let m = WITNESS_ANCHOR_RE.exec(fullText);
    m !== null;
    m = WITNESS_ANCHOR_RE.exec(fullText)
  ) {
    const search = fullText.slice(m.index, m.index + 600);
    const sentenceEnd = /\.\s*\n/.exec(search);
    if (!sentenceEnd) continue;
    const scanFrom = m.index + sentenceEnd.index + sentenceEnd[0].length;
    const next = walkToNextNameLine(fullText, scanFrom, 6);
    if (next) {
      emitNameAt(results, fullText, next.lineStart, next.lineEnd, 0.85);
    }
  }

  return results;
};
