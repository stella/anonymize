/**
 * Legal-form ORG detection — candidate + validator architecture.
 *
 * Replaces only the front-end of the v1 path: where v1 builds a
 * ~7 KB monolithic regex (greedy head + tail + ~600-suffix
 * alternation + nested Unicode-aware lookarounds) and feeds the
 * whole thing into `@stll/text-search`, v2 splits the work in two:
 *
 *   1. AC-flavoured literal lookup over the ~330-entry suffix
 *      lexicon — small per-suffix patterns the regex backend
 *      handles in microseconds, no DFA blowup against long
 *      preambles with embedded parentheticals.
 *   2. A small TS-side backward walker that constructs the rough
 *      span around each suffix occurrence (head words + connectors
 *      + lowercase tail tokens), matching the shape v1's regex
 *      would have produced.
 *
 * The rough span is then handed to v1's `processLegalFormMatches`
 * unchanged — that function already implements every validator
 * the v1 pipeline depends on (role-head sentence-verb trim, leading
 * clause trim, embedded list split, line-break / single-cap /
 * all-caps-line rejection, post-match accented-letter boundary,
 * etc.). The wins are:
 *
 *   - 17–730× speedup vs the monolithic regex (see PR description).
 *   - Sidesteps the upstream text-search DFA bug that drops every
 *     match on long preambles with embedded `(this "Agreement")`.
 *   - No carved-up validator logic — the 1671-line code-side
 *     validation chain is reused as-is.
 */

import type { Match } from "@stll/text-search";
import { TextSearch } from "@stll/text-search";

import type { Entity } from "../types";
import {
  getKnownLegalSuffixes,
  processLegalFormMatches,
  warmLegalRoleHeads,
} from "./legal-forms";

// Normalised suffix set for the "word before `and` is itself a
// legal-form suffix" boundary check — strip dots/spaces so "LLC",
// "Inc.", and "s.r.o." all reduce to a comparable token.
const normalizeSuffixToken = (s: string): string =>
  s.replace(/[.,\s]/g, "").toLowerCase();

let cachedNormalizedSuffixes: ReadonlySet<string> | null = null;
const getNormalizedSuffixSet = (): ReadonlySet<string> => {
  if (cachedNormalizedSuffixes !== null) return cachedNormalizedSuffixes;
  const out = new Set<string>();
  for (const s of getKnownLegalSuffixes()) {
    const n = normalizeSuffixToken(s);
    if (n.length > 0) out.add(n);
  }
  cachedNormalizedSuffixes = out;
  return out;
};

const isLegalFormSuffixWord = (word: string): boolean => {
  const n = normalizeSuffixToken(word);
  if (n.length === 0) return false;
  return getNormalizedSuffixSet().has(n);
};

// ── Suffix index (AC-flavoured literal pass) ────────────────────

let cachedSuffixSearch: { ts: TextSearch; suffixes: readonly string[] } | null =
  null;

// `@stll/text-search` always uses regex semantics, including for the
// `regex: false` mode — `.` is a wildcard unless escaped. Dotted
// suffixes (`Inc.`, `s.r.o.`, `S.A.`) need their metacharacters
// escaped before they hit the pattern set; otherwise `o.d.` would
// match `ood` inside `Food`.
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
  // longest-first, which gives the regex backend longest-match-
  // first behaviour for overlapping forms like `LLP` vs `LLLP` vs
  // `PLLC`.
  const patterns = suffixes.map(escapeRegex);
  const ts = new TextSearch(patterns, {
    regex: true,
  } as unknown as never);
  cachedSuffixSearch = { ts, suffixes };
  return cachedSuffixSearch;
};

// ── Boundary helpers ────────────────────────────────────────────

const ANY_LETTER_RE = /\p{L}/u;
const ANY_LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

const isTrailingBoundary = (fullText: string, end: number): boolean => {
  if (end >= fullText.length) return true;
  const next = fullText.charAt(end);
  // Reject when the suffix bleeds into a real word — covers both
  // ASCII (`LLCx`) and accented Latin (`AGÊNCIA`). Digit
  // continuations (`LLC123`) are not org-name boundaries either.
  if (ANY_LETTER_RE.test(next)) return false;
  if (/\d/.test(next)) return false;
  return true;
};

const isLeadingSeparator = (fullText: string, suffixStart: number): boolean => {
  if (suffixStart === 0) return true;
  const prev = fullText.charAt(suffixStart - 1);
  // The separator between the head and the suffix is at most
  // a single space, comma, or run of those — anything else
  // means we'd be slicing into a real word.
  return !ANY_LETTER_OR_DIGIT_RE.test(prev);
};

// ── Greedy backward walker ──────────────────────────────────────
//
// Emits a rough span around each suffix occurrence, large enough
// that v1's `processLegalFormMatches` validators can decide how
// much (if any) to trim. The walk admits the same token shapes
// v1's regex `(head + optional lowercase tail)` admits:
//
//   head : CapWord | ALL-CAPS | single Cap | digit
//   tail : LowerWord | CapWord | ALL-CAPS | digit
//          connected by a SimpleSep (HSPACE, comma, dash, dot, &)
//          or LowerConnector (a / and / und / et / e / y / i)
//
// Up to 20 tokens total, matching the per-prefix cap in
// `buildPatternString`. The walker never crosses a hard newline.

const HEAD_TOKEN_CAP = 20;

const TOKEN_RE = /[\p{L}\p{N}'’.&\-]+/u;

// Treat NBSP (U+00A0) and narrow NBSP (U+202F) as whitespace —
// DOCX exports routinely use them between name tokens and the
// trailing legal-form suffix ("Acme s.r.o.").
const isInterTokenWs = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === " " || ch === " " || ch === ",";

const findTokenBefore = (
  fullText: string,
  pos: number,
): { start: number; end: number; text: string } | null => {
  let end = pos;
  // Skip horizontal whitespace / commas back. Refuse hard newlines.
  while (end > 0) {
    const ch = fullText.charAt(end - 1);
    if (ch === "\n") return null;
    if (isInterTokenWs(ch) || ch === ";") {
      end--;
      continue;
    }
    break;
  }
  if (end === 0) return null;
  let start = end;
  while (start > 0) {
    const ch = fullText.charAt(start - 1);
    if (ch === "\n") break;
    if (!TOKEN_RE.test(ch)) break;
    start--;
  }
  if (start === end) return null;
  return { start, end, text: fullText.slice(start, end) };
};

// `Cena. KB poskytla úvěr.` — the AC suffix lookup catches `KB`,
// the backward walker grabs `Cena.` because the `.` is admitted
// by TOKEN_RE. Reject candidates whose backward span crosses a
// sentence-ending period — `<Lu><Ll>+\.<space>` immediately
// before the suffix anchor is the structural marker.
const crossesSentenceEnd = (
  fullText: string,
  candidateStart: number,
  suffixStart: number,
): boolean => {
  // Sentence-end shape immediately inside the candidate range
  // signals that the walker swept across a sentence boundary
  // (`...Cena. KB poskytla úvěr.` or `... Co.\nLLC. Except for
  // Goldman Sachs & Co. LLC`). Two shapes count:
  //   `<Cap><lowercase{2,}>.<whitespace>` — ordinary sentence
  //                                         like `Cena.<space>`.
  //   `<Cap>{2,}\.<whitespace>`           — all-caps acronym or
  //                                         legal-form suffix used
  //                                         sentence-finally like
  //                                         `LLC.<space>Except`.
  const slice = fullText.slice(candidateStart, suffixStart);
  return /\p{Lu}\p{Ll}{2,}\.\s/u.test(slice) || /\p{Lu}{2,}\.\s/u.test(slice);
};

const UPPER_LETTER_RE = /^\p{Lu}/u;
const LOWER_LETTER_RE = /^\p{Ll}/u;
const DIGIT_RE = /^\d/;
const CONNECTOR_RE = /^(?:a|and|und|et|e|y|i|&)$/i;

const isAcceptableToken = (tok: string): boolean => {
  if (tok.length === 0) return false;
  if (UPPER_LETTER_RE.test(tok)) return true;
  if (DIGIT_RE.test(tok)) return true;
  if (CONNECTOR_RE.test(tok)) return true;
  // Lowercase tail tokens (`pracovní`, `plošiny`, `s`, `r`, `o`)
  // are admitted — v1's tail allowed up to 10 of them. The
  // role-head trim downstream rips them out when the leading
  // chunk turns out to be clause prose.
  if (LOWER_LETTER_RE.test(tok)) return true;
  return false;
};

// Multi-char "and"-type connectors. v1's `extendBackward` refuses
// to cross one when only one uppercase word precedes it ("Paul
// Newman and Apple, Inc." → "Apple, Inc.") because the leading
// pattern looks like a person name. Three or more upper words
// before the connector is a real multi-word org name and the
// walker crosses ("UniCredit Bank Czech Republic and Slovakia,
// a.s."). v2 applies the same rule on the way back.
const AND_TYPE_CONNECTOR_RE = /^(?:and|und|et)$/i;

// "Elon R. Musk and X Corp." — the middle initial `R.` is a Cap
// token but the whole shape is a personal name, not a multi-word
// org. v1 looks for the `<Initial>.<HSPACE><Surname>` shape
// immediately before the connector. The check here looks at the
// 32 chars preceding the connector and asks whether they end in
// `<Lu>.<space><Word><whitespace>` — i.e. an initial + dot, then
// a final surname token right before the connector.
const MIDDLE_INITIAL_RE = /\p{Lu}\.[^\S\n]+\p{L}[\p{L}\p{M}'’]*[^\S\n]*$/u;
const hasMiddleInitialBefore = (fullText: string, pos: number): boolean => {
  const slice = fullText.slice(Math.max(0, pos - 32), pos);
  return MIDDLE_INITIAL_RE.test(slice);
};

/**
 * Count consecutive uppercase-starting tokens immediately before
 * `pos`. Stops at the first non-upper token, a hard newline, or
 * text start.
 */
const countUpperBefore = (fullText: string, pos: number): number => {
  let scan = pos;
  let count = 0;
  while (true) {
    const tok = findTokenBefore(fullText, scan);
    if (!tok) break;
    if (!UPPER_LETTER_RE.test(tok.text)) break;
    count++;
    scan = tok.start;
  }
  return count;
};

const walkBackward = (fullText: string, suffixStart: number): number => {
  let pos = suffixStart;
  let stepsLeft = HEAD_TOKEN_CAP;
  let leftmostCapPos = -1;

  while (stepsLeft > 0) {
    const tok = findTokenBefore(fullText, pos);
    if (!tok) break;
    if (!isAcceptableToken(tok.text)) break;

    // Clause-descriptor boundary. A lowercase token that is
    // ITSELF a known legal-form descriptor (`corporation`,
    // `company`, `s.r.o.`, …) followed by a comma marks a clause
    // break (`Delaware corporation, X Holdings I, Inc.` — the
    // comma sits between two separate entities). Without the
    // suffix-word gate this would also fire inside long Czech
    // names whose lowercase tail is part of the name
    // (`Krajská správa, příspěvková organizace`), so we require
    // both the suffix-word match AND a CapWord already accepted
    // to the right.
    if (LOWER_LETTER_RE.test(tok.text) && leftmostCapPos >= 0) {
      const afterTok = fullText.slice(tok.end, pos);
      if (/^[,;]/.test(afterTok) && isLegalFormSuffixWord(tok.text)) break;
    }

    // Connector boundary checks. We're considering crossing a
    // connector — three reasons not to:
    //
    //   (a) The word immediately BEFORE the connector is itself
    //       a legal-form suffix (`Morgan Securities LLC and Allen
    //       & Company LLC`, `RELAKA s.r.o. a AGROBIOPLYN s.r.o.`
    //       — the connector sits between two complete orgs, not
    //       inside one). Applies to every connector.
    //   (b) (`and`-type only) ≤2 uppercase tokens precede the
    //       connector — `Paul Newman and X, Inc.` shape.
    //   (c) (`and`-type only) the previous token is a middle
    //       initial (`Elon R. Musk and X Corp.` — the personal
    //       name extends through the initial dot).
    //
    // Three uppercase tokens or more before an `and`-type connector
    // signal a real multi-word org name (`UniCredit Bank Czech
    // Republic and Slovakia, a.s.`) and the walker crosses.
    if (CONNECTOR_RE.test(tok.text)) {
      const prevPeek = findTokenBefore(fullText, tok.start);
      if (prevPeek && isLegalFormSuffixWord(prevPeek.text)) break;
      if (AND_TYPE_CONNECTOR_RE.test(tok.text)) {
        const upperBefore = countUpperBefore(fullText, tok.start);
        if (upperBefore <= 2) break;
        if (hasMiddleInitialBefore(fullText, tok.start)) break;
      }
    }

    if (UPPER_LETTER_RE.test(tok.text)) {
      leftmostCapPos = tok.start;
    }
    pos = tok.start;
    stepsLeft--;
  }

  return leftmostCapPos < 0 ? suffixStart : leftmostCapPos;
};

// ── Public API ──────────────────────────────────────────────────

export const warmLegalFormsV2 = warmLegalRoleHeads;

/**
 * Synthesise the `Match` objects v1's `processLegalFormMatches`
 * expects. Pattern index 0 with `sliceStart=0, sliceEnd=1` lets
 * every synthesised match pass the slice gate without depending on
 * a real unified-search pattern table.
 */
type SynthMatch = Match & { text: string };

const synthMatch = (
  start: number,
  end: number,
  fullText: string,
): SynthMatch => ({
  start,
  end,
  pattern: 0,
  text: fullText.slice(start, end),
});

export const detectLegalFormsV2 = (fullText: string): Entity[] => {
  const { ts } = getSuffixSearch();
  const candidates: SynthMatch[] = [];

  for (const match of ts.findIter(fullText)) {
    const suffixStart = match.start;
    const suffixEnd = match.end;

    // SEC EDGAR line wrap: `Goldman Sachs & Co.\nLLC` — terminal
    // suffix on its own line after a dotted business designator.
    // Allow crossing a single newline ONLY when the line above
    // ends in `<word>.` (a dotted abbreviation). v1 has the same
    // narrow allowance in its DOTTED_LINE_WRAP pattern.
    let effectiveSuffixStart = suffixStart;
    if (suffixStart > 0 && fullText.charAt(suffixStart - 1) === "\n") {
      const prevLineEnd = suffixStart - 1;
      const trimmedEnd = (() => {
        let p = prevLineEnd;
        while (p > 0 && fullText.charAt(p - 1) === " ") p--;
        return p;
      })();
      if (trimmedEnd > 0 && fullText.charAt(trimmedEnd - 1) === ".") {
        effectiveSuffixStart = trimmedEnd;
      }
    }

    if (!isLeadingSeparator(fullText, effectiveSuffixStart)) continue;
    if (!isTrailingBoundary(fullText, suffixEnd)) continue;

    const candidateStart = walkBackward(fullText, effectiveSuffixStart);
    if (candidateStart >= effectiveSuffixStart) continue; // no head body
    if (crossesSentenceEnd(fullText, candidateStart, effectiveSuffixStart))
      continue;

    candidates.push(synthMatch(candidateStart, suffixEnd, fullText));
  }

  if (candidates.length === 0) return [];

  // When the AC pass finds both a nested suffix and the outer
  // suffix on the same span (`Goldman Sachs & Co.` + `Goldman
  // Sachs & Co.\nLLC` for the line-wrap case), prefer the
  // longer span — the validator pipeline emits one entity per
  // candidate, so otherwise we'd ship both. Pure overlap; the
  // legitimate sibling-org split is already done by
  // splitEmbeddedLegalFormList inside processLegalFormMatches.
  const dedupedCandidates = dropOverlapping(candidates);

  // Hand the rough spans to v1's full validator pipeline —
  // role-head trim, leading-clause trim, embedded-list split,
  // line-break check, all-caps-line rejection, post-match
  // accented-letter boundary — all already implemented there.
  return processLegalFormMatches(dedupedCandidates, 0, 1, fullText);
};

const dropOverlapping = (candidates: SynthMatch[]): SynthMatch[] => {
  const sorted = [...candidates].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const out: SynthMatch[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start >= last.start && c.end <= last.end) continue;
    out.push(c);
  }
  return out;
};
