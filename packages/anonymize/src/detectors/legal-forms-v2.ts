/**
 * Legal-form ORG detection — candidate + validator architecture.
 *
 * Replaces the monolithic regex used by `legal-forms.ts` with the
 * pattern Codex flagged as the right long-term shape (see PR #167
 * discussion):
 *
 *   1. Aho-Corasick literal pass over the ~330-entry suffix lexicon
 *      finds suffix occurrences. No regex alternation, no DFA blowup.
 *   2. For each suffix hit, a small backward walker collects the
 *      preceding company-name tokens (CapWord / ALL-CAPS / single Cap
 *      / digit / connector / in-name preposition) up to N tokens.
 *   3. A code-side validator applies all the "is this clause prose vs.
 *      in-name" rules in straight TypeScript, where each rule is
 *      debuggable and cheap.
 *
 * Lives behind `PipelineConfig.enableLegalFormsV2` so v1 stays the
 * default until full parity is demonstrated. Initial scope is the
 * common Latin-script English / continental-EU shapes that 90 %+ of
 * real contracts use. Edge cases that depend on long Czech / Slovak
 * boilerplate continue to be served by v1.
 */

import { TextSearch } from "@stll/text-search";

import type { Entity } from "../types";
import { DETECTION_SOURCES } from "../types";
import { getKnownLegalSuffixes, warmLegalRoleHeads } from "./legal-forms";

const SCORE = 0.95;

// ── Suffix index (Aho-Corasick literal pass) ────────────────────

let cachedSuffixSearch: { ts: TextSearch; suffixes: readonly string[] } | null =
  null;

// text-search treats `.` as a wildcard in every mode, so dotted
// suffixes (`Inc.`, `s.r.o.`, `S.A.`) need their metacharacters
// escaped before they hit the pattern set; otherwise `o.d.` would
// match `ood` inside `Food`. Letters / digits pass through
// unchanged.
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getSuffixSearch = (): {
  ts: TextSearch;
  suffixes: readonly string[];
} => {
  const suffixes = getKnownLegalSuffixes();
  if (cachedSuffixSearch !== null && cachedSuffixSearch.suffixes === suffixes) {
    return cachedSuffixSearch;
  }
  // `getKnownLegalSuffixes` already returns the list sorted
  // longest-first, which gives the regex backend the right
  // longest-match-first behaviour for overlapping forms like
  // `LLP` vs `LLLP` vs `PLLC`.
  const patterns = suffixes.map(escapeRegex);
  // text-search type defs don't list the `regex` option but the
  // runtime accepts it (used by legal-forms.ts pattern 0). Cast
  // to bypass the incomplete typing.
  const ts = new TextSearch(patterns, { regex: true } as unknown as never);
  cachedSuffixSearch = { ts, suffixes };
  return cachedSuffixSearch;
};

// ── Boundary helpers ────────────────────────────────────────────

// Unicode letter — covers accented Latin (Ê, Ú, ç) plus non-Latin
// scripts. Used to reject a suffix candidate when the trailing char
// is a real letter (the v1 fix at the same site, lifted into v2).
const ANY_LETTER_RE = /\p{L}/u;

const isTrailingBoundary = (fullText: string, end: number): boolean => {
  if (end >= fullText.length) return true;
  const next = fullText.charAt(end);
  // Reject when the suffix bleeds into a real word — covers both
  // ASCII (`LLCx`) and accented Latin (`AGÊNCIA`).
  if (ANY_LETTER_RE.test(next)) return false;
  // Digit immediately after the suffix is suspicious too
  // (`LLC123`, `Inc.42`) and isn't a real org-name boundary.
  if (/\d/.test(next)) return false;
  return true;
};

const isLeadingSeparator = (fullText: string, suffixStart: number): boolean => {
  if (suffixStart === 0) return false;
  const prev = fullText.charAt(suffixStart - 1);
  return /[\s,]/.test(prev);
};

// ── Backward candidate walker ───────────────────────────────────

type WordSpan = { start: number; end: number; text: string };

const WORD_RE = /[\p{L}\p{N}'’.&]+/u;

/**
 * Find the word ending at-or-just-before `pos`. Returns null when
 * the position is at text start or only whitespace lies behind it.
 */
const findWordBefore = (fullText: string, pos: number): WordSpan | null => {
  let end = pos;
  while (end > 0 && /[\s,]/.test(fullText.charAt(end - 1))) {
    end--;
  }
  if (end === 0) return null;
  // Stop at newline — backward walks never cross a hard line break.
  if (fullText.slice(end, pos).includes("\n")) return null;
  let start = end;
  while (start > 0 && WORD_RE.test(fullText.charAt(start - 1))) {
    start--;
    if (fullText.charAt(start) === "\n") {
      start++;
      break;
    }
  }
  if (start === end) return null;
  return { start, end, text: fullText.slice(start, end) };
};

const CONNECTOR_RE = /^(?:a|and|und|et|e|y|i|&)$/i;
const IN_NAME_PREP_RE = /^(?:of|the|de|du|la|le|del|della|el|al)$/i;
const UPPER_LETTER_RE = /^\p{Lu}/u;

/**
 * Walk left from a suffix start to find the leftmost token that
 * still belongs to the company name. Stops at sentence boundaries,
 * lowercase prose, paragraph breaks, and the soft 10-token cap.
 */
const walkBackward = (fullText: string, suffixStart: number): number => {
  let pos = suffixStart;
  let stepsLeft = 10;
  let firstUpperPos = suffixStart;
  let lastWordWasConnector = false;

  while (stepsLeft > 0) {
    const word = findWordBefore(fullText, pos);
    if (!word) break;

    const isUpper = UPPER_LETTER_RE.test(word.text);
    const isConnector = CONNECTOR_RE.test(word.text);
    const isInNamePrep = IN_NAME_PREP_RE.test(word.text);

    if (isUpper) {
      firstUpperPos = word.start;
      pos = word.start;
      lastWordWasConnector = false;
      stepsLeft--;
      continue;
    }

    // Lowercase connectors and in-name prepositions are only
    // accepted between two uppercase tokens. Refuse a leading
    // connector at the entity boundary.
    if (isConnector || isInNamePrep) {
      const prevPeek = findWordBefore(fullText, word.start);
      if (!prevPeek || !UPPER_LETTER_RE.test(prevPeek.text)) break;
      pos = word.start;
      lastWordWasConnector = true;
      stepsLeft--;
      continue;
    }

    break;
  }

  // If the leftmost step was a connector, retreat it.
  if (lastWordWasConnector) {
    const peek = findWordBefore(fullText, pos);
    if (peek && CONNECTOR_RE.test(peek.text)) {
      // Already retreated; nothing to do.
    }
  }

  return firstUpperPos;
};

// ── Validators ──────────────────────────────────────────────────

/**
 * Reject candidates whose head looks like clause prose ("This
 * Agreement is entered into between Acme Inc." → Acme Inc.).
 * Handled here in code instead of the regex, so it's debuggable
 * and per-rule comments stay in TS rather than embedded in a 7 KB
 * pattern.
 */
const trimClauseProse = (
  fullText: string,
  start: number,
  end: number,
): number => {
  // If the span text contains a lowercase prose verb that's a
  // recognised sentence-verb indicator before the rightmost
  // CapWord run, slice to that run instead. Implementation kept
  // simple: scan word by word from the left, drop until the first
  // CapWord that isn't immediately followed by a lowercase
  // sentence verb.
  const text = fullText.slice(start, end);
  const words = [...text.matchAll(/[\p{L}\p{N}.'’]+/gu)];
  let trimToOffset = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    const next = words[i + 1]!;
    if (
      UPPER_LETTER_RE.test(w[0]) &&
      /^\p{Ll}/u.test(next[0]) &&
      SENTENCE_VERB_HINTS.has(next[0].toLowerCase())
    ) {
      // Cut after this lowercase verb (and any subsequent prose);
      // the actual entity head is the next CapWord that follows.
      const verbEnd = next.index! + next[0].length;
      const after = text.slice(verbEnd);
      const capMatch = /[\p{Lu}]/u.exec(after);
      if (capMatch) {
        trimToOffset = verbEnd + capMatch.index;
      }
    }
  }
  return start + trimToOffset;
};

// Conservative seed set — a fuller list lives in
// `data/sentence-verb-indicators.json`; v2 keeps the most common
// English forms inline so the validator stays self-contained.
// A follow-up can wire the per-language dictionary in.
const SENTENCE_VERB_HINTS: ReadonlySet<string> = new Set([
  "is",
  "are",
  "was",
  "were",
  "owns",
  "grants",
  "sells",
  "sold",
  "buys",
  "bought",
  "has",
  "holds",
  "agrees",
  "pays",
  "paid",
  "owes",
  "signs",
  "signed",
  "leases",
  "rents",
  "entered",
  "made",
  "executed",
]);

const trimTrailingPunctuation = (text: string): string =>
  text.replace(/[\s,;:]+$/u, "");

// ── Public API ──────────────────────────────────────────────────

/**
 * Async warmer — keeps parity with the v1 path. Pipeline already
 * calls `warmLegalRoleHeads()` before invoking the legal-form
 * detector; v2 piggybacks on the same cache so the suffix list is
 * ready by the time `detectLegalFormsV2` runs.
 */
export const warmLegalFormsV2 = warmLegalRoleHeads;

export const detectLegalFormsV2 = (fullText: string): Entity[] => {
  const { ts } = getSuffixSearch();
  const results: Entity[] = [];

  for (const match of ts.findIter(fullText)) {
    const suffixStart = match.start;
    const suffixEnd = match.end;

    if (!isLeadingSeparator(fullText, suffixStart)) continue;
    if (!isTrailingBoundary(fullText, suffixEnd)) continue;

    const candidateStart = walkBackward(fullText, suffixStart);
    if (candidateStart >= suffixStart) continue; // no name body

    const trimmedStart = trimClauseProse(fullText, candidateStart, suffixEnd);
    const text = trimTrailingPunctuation(
      fullText.slice(trimmedStart, suffixEnd),
    );
    if (text.length < 3) continue;

    // Skip if the candidate starts AT a recognised sentence-verb
    // word — the backward walk over-shot into prose.
    const headMatch = /^[\p{L}]+/u.exec(text);
    if (
      headMatch &&
      /^\p{Ll}/u.test(headMatch[0]) &&
      SENTENCE_VERB_HINTS.has(headMatch[0].toLowerCase())
    ) {
      continue;
    }

    results.push({
      start: trimmedStart,
      end: trimmedStart + text.length,
      label: "organization",
      text,
      score: SCORE,
      source: DETECTION_SOURCES.REGEX,
    });
  }

  return mergeAdjacent(results);
};

// AC literal mode can return overlapping suffix hits when the
// vocabulary contains nested forms (`LLC` and `PLLC`); de-dupe by
// preferring the longest entity span at each position.
const mergeAdjacent = (entities: Entity[]): Entity[] => {
  if (entities.length === 0) return [];
  const sorted = [...entities].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const out: Entity[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.start < last.end && e.end <= last.end) continue;
    out.push(e);
  }
  return out;
};
