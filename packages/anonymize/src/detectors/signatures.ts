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
 *     signature fields. When the value sits on the
 *     same line we use it directly; when the label is
 *     on its own line we walk forward to the next
 *     non-empty non-image line.
 *
 *   • "IN WITNESS WHEREOF" / "In Witness Whereof" —
 *     the standard preamble. We walk past the preamble
 *     sentence and try the next several short lines
 *     until one validates as a name.
 *
 * Heuristics applied to every emission:
 *   - Same-line tables ("/s/ Jane Doe   CEO   5/1/24")
 *     split on 3+ whitespace; only the first cell is
 *     treated as the signer.
 *   - Trailing post-nominal suffixes (", Jr.", ", M.D.")
 *     are stripped before validation.
 *   - Lowercase name particles ("van der", "de la",
 *     "von") are allowed between capitalised tokens.
 *   - At least two tokens required; single capitalised
 *     words ("President", "Director") are rejected.
 *   - Lines containing legal-form suffixes (LLC, INC.,
 *     GMBH, s.r.o., …) are rejected to stop party
 *     captions sitting directly above a "/s/" mark
 *     from being mis-tagged as persons.
 *
 * The detector emits with source TRIGGER (priority 4)
 * so signature-anchored detections outrank deny-list
 * heuristics that may otherwise mis-classify part of
 * the name ("Sean D Reilly" — deny-list previously
 * caught only "Reilly").
 */

const SLASH_S_RE = /\/s\/[ \t]*/g;
// Match `Name:` / `By:` anywhere on a line (anchored on
// a word boundary), not just at line start. Capturing
// is non-greedy and bounded by either the next column
// boundary (3+ spaces / tab) or a newline, so two-column
// signature blocks ("Name: Priya Ramanathan   Name:
// Jonathan H. Whitaker") emit a span per signer.
const LABELLED_NAME_RE =
  /\b(?:By|Name)[ \t]*:[ \t]*(?:\/s\/[ \t]+)?([^\n]*?)(?=\s{3,}|[\t]|\n|$)/gi;
const WITNESS_ANCHOR_RE = /\bIN WITNESS WHEREOF\b[^\n]*\n/gi;

// Tokens allowed as lowercase name particles between
// two cap tokens ("Juan de la Cruz", "Hans van der
// Meer", "Vincent van Gogh", "Jean d'Arc"). Restricted
// to a curated list of common particles so we don't
// promote arbitrary lowercase prose into name shape.
// Shared with the trigger detector's person name-run
// boundary (see detectors/triggers.ts).
export const NAME_PARTICLE =
  "(?:de|del|della|der|den|di|du|da|das|do|dos|el|la|le|van|von|y|zu|af|ben|bin|al|d'|d’)";
const CAP_TOKEN = "\\p{Lu}[\\p{L}\\p{M}.'\\-]{0,30}";
// A name: starts with a cap token, then 1-4 more
// tokens which may be cap tokens or lowercase
// particles. Requires ≥2 tokens total so role titles
// like "President" don't qualify.
const NAME_SHAPE_RE = new RegExp(
  `^${CAP_TOKEN}(?:[ \\t]+(?:${NAME_PARTICLE}|${CAP_TOKEN})){1,4}$`,
  "u",
);
const MAX_NAME_LEN = 60;

// Trailing post-nominal suffixes ("John Smith, Jr.",
// "Jane Doe, M.D.", "Alex Park, Esq."). Stripped
// before validation so the comma doesn't poison the
// name-shape check.
const POST_NOMINAL_SUFFIX_RE =
  /,\s*(?:Jr|Sr|II|III|IV|V|Esq|Esquire|M\.?D|Ph\.?D|J\.?D|LL\.?M|MBA|CPA|PE|RN|DDS|DVM|DO|MD|CFA|CFP)\.?\s*$/i;

// 3+ whitespace or any tab marks a column boundary in
// signature tables ("/s/ Jane Doe   CEO   5/1/24").
const COLUMN_SEPARATOR_RE = /\s{3,}|\t+/;

// Quick recognition of common legal-form suffixes so we
// can refuse to emit a previous-line "name" when that
// line is actually a party caption. Case-insensitive;
// matches in any token position.
const ORG_SUFFIX_RE =
  /\b(?:INC\.?|LLC|LLP|LP|CORP\.?|CORPORATION|LTD\.?|GMBH|AG|SE|KG|OHG|SA|SAS|SARL|S\.A\.?|S\.P\.A\.?|PLC|N\.A\.?|N\.V\.?|B\.V\.?|PTY\s+LTD\.?|CO\.|S\.R\.O\.?|A\.S\.?|Z\.S\.?|S\.\s*P\.?|LTDA\.?|EIRELI|EPP|S\/A)\b/i;

// Lines that look like image stubs or section markers
// — skip them when walking forward from a witness
// anchor.
const IMAGE_STUB_RE = /^(?:\[?img|\[image|\[logo|\(logo\))/i;

const normaliseCandidate = (text: string): string => {
  let candidate = text.trim();
  candidate = candidate.replace(POST_NOMINAL_SUFFIX_RE, "").trim();
  const cells = candidate.split(COLUMN_SEPARATOR_RE);
  const firstCell = cells[0]?.trim() ?? candidate;
  return firstCell;
};

const isNameShape = (text: string): boolean => {
  if (text.length === 0 || text.length > MAX_NAME_LEN) return false;
  if (text.length < 3) return false;
  if (!NAME_SHAPE_RE.test(text)) return false;
  return true;
};

const findLineEnd = (text: string, pos: number): number => {
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
};

// Try to extract a normalised name from a span and emit
// it as a person entity. Returns true when an entity was
// emitted. Skips the emission if the source span looks
// like an organisation caption (contains a legal-form
// suffix) — these should be claimed by the legal-form
// detector, not the signature detector.
const tryEmit = (
  results: Entity[],
  fullText: string,
  start: number,
  end: number,
  score: number,
): boolean => {
  const raw = fullText.slice(start, end);
  if (ORG_SUFFIX_RE.test(raw)) return false;
  const candidate = normaliseCandidate(raw);
  if (!isNameShape(candidate)) return false;
  // Re-locate the candidate inside the raw slice so the
  // entity coordinates are tight.
  const offset = raw.indexOf(candidate);
  if (offset < 0) return false;
  const absStart = start + offset;
  results.push({
    start: absStart,
    end: absStart + candidate.length,
    label: "person",
    text: candidate,
    score,
    source: DETECTION_SOURCES.TRIGGER,
  });
  return true;
};

// Walk forward up to `maxLines` non-empty non-image
// lines and emit the first one that validates as a
// name. Codex P2: emits previously stopped at the
// first non-empty line even if validation failed,
// which prevented witness-block scans from reaching
// the printed signer through intervening "By:" /
// "COMPANY:" lines.
const tryEmitForwardLines = (
  results: Entity[],
  fullText: string,
  fromPos: number,
  maxLines: number,
  score: number,
): boolean => {
  let pos = fromPos;
  for (let i = 0; i < maxLines; i++) {
    if (pos >= fullText.length) return false;
    const lineEnd = findLineEnd(fullText, pos);
    const line = fullText.slice(pos, lineEnd).trim();
    if (line.length > 0 && !IMAGE_STUB_RE.test(line)) {
      if (tryEmit(results, fullText, pos, lineEnd, score)) return true;
    }
    pos = lineEnd + 1;
  }
  return false;
};

const findPrevLine = (
  fullText: string,
  pos: number,
): { lineStart: number; lineEnd: number } | null => {
  let cursor = pos - 1;
  while (cursor >= 0 && fullText.charAt(cursor) !== "\n") cursor--;
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
      // Column-aware: in a tabular signature row
      // ("/s/ Jane Doe   Chief Executive Officer
      // 5/1/2024"), only the first cell after "/s/" is
      // the signer; subsequent cells are title/date.
      const rawSlice = fullText.slice(afterMark, lineEnd);
      const cells = rawSlice.split(COLUMN_SEPARATOR_RE);
      const firstCell = cells[0] ?? "";
      if (firstCell.trim().length > 0) {
        const firstCellEnd = afterMark + firstCell.length;
        tryEmit(results, fullText, afterMark, firstCellEnd, 0.95);
      }
    } else {
      tryEmitForwardLines(results, fullText, lineEnd + 1, 4, 0.9);
    }

    // Previous-line lookback. EDGAR documents often
    // print the signatory's name in ALL CAPS on its
    // own line directly above the "/s/" mark
    // ("ELON R. MUSK\n/s/ Elon R. Musk"). Skip the
    // lookback when the previous line is a party
    // caption (contains a legal-form suffix) so a
    // line like "TWITTER, INC.\n/s/ Jane Doe" doesn't
    // mis-emit the company name as a person.
    const prev = findPrevLine(fullText, m.index);
    if (prev) {
      tryEmit(results, fullText, prev.lineStart, prev.lineEnd, 0.85);
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
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
      // Label sits on its own line — walk forward to the
      // next non-empty line for the printed name.
      tryEmitForwardLines(results, fullText, valueEnd + 1, 3, 0.9);
      continue;
    }
    tryEmit(results, fullText, valueStart, valueEnd, 0.95);
  }

  // Pass 3: "IN WITNESS WHEREOF" preamble.
  WITNESS_ANCHOR_RE.lastIndex = 0;
  for (
    let m = WITNESS_ANCHOR_RE.exec(fullText);
    m !== null;
    m = WITNESS_ANCHOR_RE.exec(fullText)
  ) {
    const search = fullText.slice(m.index, m.index + 600);
    // Permissive sentence terminator — `.`, `:`, `;`,
    // or just a newline closes the preamble. Some
    // contracts run the preamble straight into the
    // signature block with only a paragraph break.
    const sentenceEnd = /[.:;]\s*\n|\n\s*\n/.exec(search);
    if (!sentenceEnd) continue;
    const scanFrom = m.index + sentenceEnd.index + sentenceEnd[0].length;
    tryEmitForwardLines(results, fullText, scanFrom, 6, 0.85);
  }

  return results;
};
