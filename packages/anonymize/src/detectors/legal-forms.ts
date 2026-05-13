/**
 * Legal form detection for company/organization names.
 *
 * Detects company names by finding legal form suffixes
 * (s.r.o., GmbH, a.s., etc.) and extending backwards
 * to capture preceding capitalised words.
 *
 * Exports pattern definitions for the unified builder
 * and a match processor for post-processing.
 */

import type { Match } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { DASH_INNER } from "../util/char-groups";
import { loadLanguageConfigs } from "../util/lang-loader";

const UPPER = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑ\\u0130";
const LOWER = "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñ\\u0131";
const CAP_WORD = `(?:[${UPPER}]{2,}|[${UPPER}][${LOWER}${UPPER}]+)`;
// All-caps word: 2+ uppercase letters, no lowercase.
// For company names like "EAGLES BRNO", max 3 words.
const ALLCAP_WORD = `[${UPPER}]{2,}`;

const ROMAN_NUMERAL_RE =
  /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

// Generic legal/contract role words that should never appear
// at the head of an organisation name. When a greedy regex
// sweep includes one of these as the first word, the span is
// a sentence fragment, not a real company (e.g. "Vendor 1
// owns an equity interest in the Acme s.r.o. company"). The
// processor trims back to the last real Cap-starting word in
// that case. Per-language word lists live under
// `data/legal-role-heads.<lang>.json`; loaded lazily and
// cached on first use.
type LegalRoleHeadsConfig = {
  words: readonly string[];
};

let legalRoleHeadsCache: ReadonlySet<string> | null = null;
let legalRoleHeadsPromise: Promise<ReadonlySet<string>> | null = null;

const loadLegalRoleHeads = async (): Promise<ReadonlySet<string>> => {
  if (legalRoleHeadsCache) return legalRoleHeadsCache;
  if (legalRoleHeadsPromise) return legalRoleHeadsPromise;
  legalRoleHeadsPromise = (async () => {
    const sets = await loadLanguageConfigs<LegalRoleHeadsConfig>(
      "legalRoleHeads",
      (mod) => {
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON config shape
        const m = mod as {
          default?: LegalRoleHeadsConfig;
        };
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON config shape
        return (m.default ?? mod) as LegalRoleHeadsConfig;
      },
    );
    const all = new Set<string>();
    for (const entry of sets) {
      if (!entry || !Array.isArray(entry.words)) continue;
      for (const word of entry.words) {
        if (typeof word === "string" && word.length > 0) {
          all.add(word.toLowerCase());
        }
      }
    }
    legalRoleHeadsCache = all;
    return all;
  })();
  return legalRoleHeadsPromise;
};

// Synchronous helper used inside `processLegalFormMatches`,
// which is a sync function called once per pipeline run. The
// pipeline calls `warmLegalRoleHeads()` before invoking it, so
// the cache is populated by the time matches are processed.
const getLegalRoleHeadsSync = (): ReadonlySet<string> =>
  legalRoleHeadsCache ?? new Set<string>();

export const warmLegalRoleHeads = async (): Promise<void> => {
  await loadLegalRoleHeads();
};

const escapeForRegex = (form: string): string =>
  form
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    // Use [^\S\n]? (optional horizontal whitespace)
    // instead of \s* to prevent greedy matching across
    // newlines which causes DFA failures in regex-set.
    .replace(/\\\./g, "\\.[^\\S\\n]?");

const isShortForm = (form: string): boolean =>
  form.replace(/[.\s]/g, "").length <= 3 && !form.includes(" ");

const buildPatternString = (forms: string[]): string | null => {
  if (forms.length === 0) {
    return null;
  }

  const sorted = forms.toSorted((a, b) => b.length - a.length);
  const alt = sorted.map(escapeForRegex).join("|");
  // Separator between name words: space, ampersand,
  // comma, dot, hyphen (1-4 chars). Connector words
  // (a, and, und, et, e, y, i) are allowed only when
  // followed by a lowercase-starting word.
  // Horizontal whitespace only (no newline) — keeping
  // newlines out of the separators prevents the DFA
  // size from blowing up across line boundaries and
  // matches the existing pattern in escapeForRegex.
  const HSPACE = "[^\\S\\n]";
  const LOWER_CONNECTOR = `${HSPACE}+(?:a|and|und|et|e|y|i)${HSPACE}+(?=[${LOWER}])`;
  const SIMPLE_SEP = `(?:${HSPACE}|[&,.${DASH_INNER}]){1,4}`;
  // Uppercase- or digit-only word for the strict head.
  // Lowercase-starting tokens can only appear in the
  // optional tail below.
  const CAP_OR_NUM_WORD = `(?:${CAP_WORD}|\\d{1,4})`;
  // A lowercase-starting word, excluding "and"/"und"/
  // "et" so they cannot sneak past the connector guard.
  const LOWER_WORD =
    `(?:(?!(?:and|und|et)(?![${UPPER}${LOWER}]))` +
    `[${LOWER}][${LOWER}${UPPER}]+)`;
  // Any word, used in the tail. Same exclusion for
  // standalone "and"/"und"/"et" as LOWER_WORD.
  const ANY_WORD_TAIL =
    `(?:(?!(?:and|und|et)(?![${UPPER}${LOWER}]))` +
    `[${UPPER}${LOWER}][${LOWER}${UPPER}]+` +
    `|[${UPPER}]{2,3}` +
    `|\\d{1,4})`;
  // Prefix structure:
  //   CapWord (SimpleSep CapOrNumWord)*           # strict head
  //   ( SimpleSep LowerWord                       # optional tail starts
  //     ((LowerConnector|SimpleSep) AnyWord)* )?  #   with a lowercase
  // The tail is bounded to a handful of tokens so legitimate
  // multi-word names ("Národní agentura pro komunikační a
  // informační technologie, s. p.", "Bank of America, Inc.")
  // still match while sentence fragments containing six-plus
  // words ahead of the legal form don't get swept in.
  const head = `(?:${CAP_WORD})(?:${SIMPLE_SEP}(?:${CAP_OR_NUM_WORD})){0,10}`;
  const tail =
    `${SIMPLE_SEP}(?:${LOWER_WORD})` +
    `(?:(?:${LOWER_CONNECTOR}|${SIMPLE_SEP})(?:${ANY_WORD_TAIL})){0,6}`;
  const prefix = `(?:${head})(?:${tail})?`;
  const separator = `(?:\\s+|,\\s*)`;

  return `${prefix}${separator}(?:${alt})(?![${LOWER}])`;
};

// ── Pattern builder for unified search ──────────────

/**
 * Build legal form regex pattern strings.
 * Returns an array of regex strings for the unified
 * TextSearch builder. Empty if data package is not
 * installed.
 */
export const buildLegalFormPatterns = async (): Promise<string[]> => {
  let data: Record<string, string[]> = {};

  try {
    const mod = await import("../data/legal-forms.json");
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
    data = (mod as { default: Record<string, string[]> }).default;
  } catch {
    return [];
  }

  const allForms: string[] = [];
  const seen = new Set<string>();

  for (const forms of Object.values(data)) {
    for (const form of forms) {
      const key = form.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allForms.push(form);
      }
    }
  }

  const patterns: string[] = [];

  const longPattern = buildPatternString(
    allForms.filter((f) => !isShortForm(f)),
  );
  if (longPattern) {
    patterns.push(longPattern);
  }

  const shortPattern = buildPatternString(allForms.filter(isShortForm));
  if (shortPattern) {
    patterns.push(shortPattern);
  }

  // All-caps company names: "EAGLES BRNO, z.s."
  // Up to 3 all-caps words before any legal form.
  // Uses all forms (both long and short).
  // No connectors — backward extension handles them.
  const allcapPrefix =
    `(?:${ALLCAP_WORD})` +
    `(?:[\\s&,.${DASH_INNER}]{1,4}(?:${ALLCAP_WORD})){0,2}`;
  const allcapAlt = allForms
    .toSorted((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");
  patterns.push(
    `${allcapPrefix}(?:\\s+|,\\s*)` + `(?:${allcapAlt})(?![${LOWER}])`,
  );

  return patterns;
};

// ── Backward extension ──────────────────────────────

const CONNECTOR_RE = /^(?:a|and|und|et|e|y|i|&)$/i;
// Multi-char "and"-type connectors. When backward
// extension hits one of these with exactly two
// uppercase words behind it, the pattern looks like
// "<First> <Last> and <ORG>" and we stop rather than
// swallow the personal name into the org span.
const AND_TYPE_CONNECTOR_RE = /^(?:and|und|et)$/i;
const UPPER_LETTER_RE = /^\p{Lu}/u;
// Capitalised words that, when they begin a legal-form
// match, signal the match is the tail of a multi-word
// organisation name ("Acme Widgets and Company, Inc.",
// "The Bank of America and Trust Company, Inc.").
// In that mode the two-cap-words "First Last and ORG"
// heuristic is suspended and a small set of in-name
// prepositions ("of") are crossable during backward
// extension. Capitalised-form only — lowercase "trust"
// or "bank" are common verbs/nouns.
const COMPANY_SUFFIX_WORDS_RE =
  /^(?:Company|Co|Bank|Brothers|Bros|Sons|Group|Holdings|Trust|Partners|Associates|Corporation|Industries|Enterprises|Solutions|Systems|Services|Foundation|Institute)$/;
const IN_NAME_PREPOSITION_RE = /^(?:of|the)$/i;
const ENTITY_HEAD_WORD_RE = /^[\p{L}\p{M}&]+/u;
const LEADING_CLAUSE_RE = /(?:^|\s)(?:by\s+and\s+between|is\s+between)\s+/giu;

/**
 * Find the word ending just before `pos` in `text`,
 * skipping any whitespace (not newlines).
 * Returns null if no word is found (e.g., at start
 * of text, or preceded by non-word chars like ".").
 */
const findWordBefore = (
  text: string,
  pos: number,
): { word: string; start: number } | null => {
  let scan = pos - 1;
  // Skip horizontal whitespace
  while (scan >= 0) {
    const ch = text.charAt(scan);
    if (ch === "\n" || !/\s/.test(ch)) break;
    scan--;
  }
  if (scan < 0 || text.charAt(scan) === "\n") {
    return null;
  }

  const wordEnd = scan + 1;
  while (scan >= 0 && /[\p{L}\p{M}&]/u.test(text.charAt(scan))) {
    scan--;
  }
  const wordStart = scan + 1;
  const word = text.slice(wordStart, wordEnd);
  if (word.length === 0) return null;
  return { word, start: wordStart };
};

/**
 * Count consecutive uppercase-starting words immediately
 * before `pos`. Stops at the first non-upper word or at
 * text/line start. Used to disambiguate "<First> <Last>
 * and <ORG>" from "<Multi-word Org> and <Continuation>".
 */
const countUpperWordsBefore = (fullText: string, pos: number): number => {
  let count = 0;
  let scan = pos;
  while (scan > 0) {
    const found = findWordBefore(fullText, scan);
    if (!found) break;
    if (!UPPER_LETTER_RE.test(found.word)) break;
    count++;
    scan = found.start;
  }
  return count;
};

/**
 * Extend a match backward through uppercase words and
 * lowercase connectors. Stops at start of text,
 * newline, or a word that doesn't qualify.
 *
 * Connectors (a, and, und, et, ...) are only consumed
 * when there is a valid word before them — a trailing
 * connector at an entity boundary is not consumed.
 * For multi-char "and"-type connectors we additionally
 * refuse to cross when exactly two uppercase words
 * precede them ("First Last and ORG, Inc." shape) —
 * unless the match itself begins with a known company-
 * suffix word ("…and Company, Inc."), in which case
 * the chain belongs to one organisation. In that
 * suffix-mode we also cross in-name prepositions
 * ("Bank of America and Trust Company, Inc.").
 */
const extendBackward = (
  fullText: string,
  matchStart: number,
  options: { forceSuffixMode?: boolean } = {},
): number => {
  // Read the first word of the match to decide whether
  // we're inside a multi-word organisation name. Callers
  // that enter the walk from a known legal-form suffix
  // (Inc., Ltd., etc.) can pass `forceSuffixMode: true`
  // to enable in-name preposition crossing ("Bank of
  // America Inc.") without having to widen
  // COMPANY_SUFFIX_WORDS_RE to every legal-form suffix.
  const headWord =
    ENTITY_HEAD_WORD_RE.exec(fullText.slice(matchStart))?.[0] ?? "";
  const suffixMode =
    options.forceSuffixMode === true ||
    COMPANY_SUFFIX_WORDS_RE.test(headWord);

  let pos = matchStart;

  while (pos > 0) {
    const found = findWordBefore(fullText, pos);
    if (!found) break;

    const { word, start: wordStart } = found;

    const isUpper = UPPER_LETTER_RE.test(word);
    const isConnector = CONNECTOR_RE.test(word);
    const isInNamePrep = suffixMode && IN_NAME_PREPOSITION_RE.test(word);

    if (isUpper) {
      // Uppercase word — always accept
      pos = wordStart;
    } else if (isConnector) {
      if (
        !suffixMode &&
        AND_TYPE_CONNECTOR_RE.test(word) &&
        countUpperWordsBefore(fullText, wordStart) === 2
      ) {
        // Looks like "<First> <Last> and <ORG>" — keep
        // the person name out of the org span.
        break;
      }
      // Connector — only accept if there is a valid
      // (uppercase-starting) word before it
      const prev = findWordBefore(fullText, wordStart);
      if (!prev) break;
      const prevIsUpper = UPPER_LETTER_RE.test(prev.word);
      if (!prevIsUpper) break;
      // Move pos back to the start of the word that
      // precedes the connector; the connector and all
      // whitespace between it and prev.start are
      // included implicitly in the entity slice.
      pos = prev.start;
    } else if (isInNamePrep) {
      // In suffix-mode only: cross lowercase in-name
      // prepositions ("of", "the") when the preceding
      // token is uppercase ("Bank of America").
      const prev = findWordBefore(fullText, wordStart);
      if (!prev) break;
      if (!UPPER_LETTER_RE.test(prev.word)) break;
      pos = prev.start;
    } else {
      break;
    }
  }

  return pos;
};

const trimLeadingClause = (text: string): { offset: number; text: string } => {
  let cut = -1;

  for (const match of text.matchAll(LEADING_CLAUSE_RE)) {
    cut = match.index + match[0].length;
  }

  if (cut <= 0) {
    return { offset: 0, text };
  }

  const trimmed = text.slice(cut);
  const leadingWs = trimmed.match(/^\s*/u)?.[0].length ?? 0;

  return {
    offset: cut + leadingWs,
    text: trimmed.slice(leadingWs),
  };
};

// ── Match processor ─────────────────────────────────

/**
 * Process legal form matches from the unified search.
 * Receives all matches; filters to the legal forms
 * slice via sliceStart/sliceEnd.
 *
 * The role-head trimming step reads per-language data from
 * a cache that `runPipeline` warms via `warmLegalRoleHeads()`
 * before calling this. Callers that invoke
 * `processLegalFormMatches` directly (without going through
 * `runPipeline`) must `await warmLegalRoleHeads()` first;
 * otherwise the trim falls back to a no-op and sentence-
 * fragment fixes do not apply.
 */
export const processLegalFormMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText?: string,
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const text = match.text.trimEnd();
    if (text.length < 5) {
      continue;
    }

    // Trim spans whose first word is a generic legal/contract
    // role IF the match also contains sentence noise (a
    // descriptive lowercase word like "owns" / "je vlastníkem")
    // between the role head and the trailing legal-form suffix.
    // Without the sentence-noise signal we keep the match intact
    // — a role word can also be the actual head of a company
    // name ("Client Solutions Inc.", "Vendor s.r.o."). When the
    // signal is present the leading sentence is dropped and the
    // entity is rebuilt from `extendBackward` rooted at the
    // legal-form suffix, so multi-word names ("Acme Holdings
    // s.r.o.", "Bank of America Inc.") and in-name prepositions
    // survive the trim.
    const roleHeads = getLegalRoleHeadsSync();
    const firstWordMatch = /^[\p{L}\p{M}]+/u.exec(text);
    let processedStart = match.start;
    let processedText = text;
    // When set, the subsequent extendBackward step is skipped:
    // the role-head trim has already run extendBackward from
    // the legal-form suffix and chosen the entity start, so
    // running it again would walk back into the very sentence
    // noise we just removed.
    let skipExtendBackward = false;
    if (
      firstWordMatch !== null &&
      roleHeads.has(firstWordMatch[0].toLowerCase()) &&
      fullText
    ) {
      // Anchor the trim at the legal-form suffix's position
      // inside fullText. The suffix sits at the trailing end of
      // the match; locate it by finding the last whitespace run
      // and taking everything from the next character on.
      const lastSepMatch = /[\s,]+(?=\S+$)/u.exec(text);
      const suffixOffset =
        lastSepMatch !== null
          ? lastSepMatch.index + lastSepMatch[0].length
          : 0;
      // Detect sentence noise: any lowercase-starting token
      // between the role-head and the suffix that isn't itself
      // a known in-name connector. If none, the match is a
      // legitimate cap-only name where the role word happens
      // to be the head — keep it.
      const midSection = text.slice(firstWordMatch[0].length, suffixOffset);
      const hasSentenceNoise = /(?<![\p{L}\p{N}])\p{Ll}[\p{L}\p{M}]+/u.test(
        midSection.replace(
          /(?<![\p{L}\p{N}])(?:of|the|and|or|de|du|le|la|al|el|y|e|i|a|und|et|van|von|der|die|das|den)(?![\p{L}\p{N}])/giu,
          "",
        ),
      );
      if (hasSentenceNoise) {
        // Walk backward from the suffix start through the
        // existing extendBackward logic, which already handles
        // cap-words, connectors, and in-name prepositions.
        const suffixStartInFull = match.start + suffixOffset;
        const extended = extendBackward(fullText, suffixStartInFull, {
          forceSuffixMode: true,
        });
        // Refuse to keep the role-head as the new head. If
        // extendBackward stops at it, advance one cap-word to
        // the right. If no usable cap remains, drop the match.
        let trimmedStart = extended;
        let trimmedEnd = match.start + text.length;
        // If extended landed inside the role-head, push past it
        // to the next cap-word inside the match.
        while (trimmedStart < suffixStartInFull) {
          const wordAtStart = /^[\p{L}\p{M}]+/u.exec(
            fullText.slice(trimmedStart, suffixStartInFull),
          );
          if (
            wordAtStart === null ||
            !roleHeads.has(wordAtStart[0].toLowerCase())
          ) {
            break;
          }
          // Skip past this role-head + the whitespace after it.
          const advanceBy = /^\S+\s+/u.exec(
            fullText.slice(trimmedStart, suffixStartInFull),
          );
          if (!advanceBy) break;
          trimmedStart += advanceBy[0].length;
        }
        if (trimmedStart >= suffixStartInFull) {
          // No real cap-word survived the trim; drop the match.
          continue;
        }
        processedStart = trimmedStart;
        processedText = fullText.slice(trimmedStart, trimmedEnd);
        skipExtendBackward = true;
      }
    }

    if (processedText.includes("\n")) {
      continue;
    }

    // Extend backward through connectors if fullText
    // is available (captures "Be a Future" from just
    // "Future s.r.o.")
    let entityStart = processedStart;
    let entityText = processedText;
    if (fullText && !skipExtendBackward) {
      const extended = extendBackward(fullText, processedStart);
      if (extended < processedStart) {
        entityStart = extended;
        entityText = fullText
          .slice(extended, processedStart + processedText.length)
          .trimEnd();
      }
    }

    const clauseTrim = trimLeadingClause(entityText);
    if (clauseTrim.offset > 0) {
      entityStart += clauseTrim.offset;
      entityText = clauseTrim.text;
    }

    // Reject all-caps matches only if the entire
    // surrounding line is all-caps (section headings
    // like "KUPNÍ SMLOUVA"). If only the company name
    // is all-caps ("uzavřená s EAGLES BRNO, z.s."),
    // keep it — max 3 all-caps words are allowed.
    const getPrefixInfo = (value: string) => {
      const prefixEnd =
        value.lastIndexOf(",") !== -1
          ? value.lastIndexOf(",")
          : value.lastIndexOf(" ");
      const prefixPart =
        prefixEnd > 0
          ? value.slice(0, prefixEnd).replace(/[^a-zA-ZÀ-ž]/g, "")
          : value.replace(/[^a-zA-ZÀ-ž]/g, "");
      return { prefixEnd, prefixPart };
    };
    let { prefixEnd, prefixPart } = getPrefixInfo(entityText);
    let isAllCapsMatch =
      prefixPart.length > 2 && prefixPart === prefixPart.toUpperCase();

    if (isAllCapsMatch && fullText) {
      // Check: is the surrounding line also all-caps?
      const lineStart = fullText.lastIndexOf("\n", entityStart);
      const lineEnd = fullText.indexOf("\n", entityStart + entityText.length);
      const line = fullText.slice(
        lineStart + 1,
        lineEnd === -1 ? fullText.length : lineEnd,
      );
      const lineLetters = line.replace(/[^a-zA-ZÀ-ž]/g, "");
      const upperCount = [...lineLetters].filter(
        (c) => c === c.toUpperCase(),
      ).length;
      const lineIsAllCaps =
        lineLetters.length > 5 && upperCount / lineLetters.length >= 0.95;
      if (lineIsAllCaps) {
        // Entire line is all-caps → heading, skip
        continue;
      }
      // Only the company name is all-caps → keep it
      // (but limit to 3 words in prefix)
      const wordCount =
        prefixPart.length > 0
          ? entityText
              .slice(0, prefixEnd > 0 ? prefixEnd : entityText.length)
              .trim()
              .split(/\s+/).length
          : 0;
      if (wordCount > 3) {
        // Keep the original regex match if backward
        // extension alone pushed the name past the
        // all-caps 3-word guard.
        entityStart = match.start;
        entityText = text;
        ({ prefixEnd, prefixPart } = getPrefixInfo(entityText));
        isAllCapsMatch =
          prefixPart.length > 2 && prefixPart === prefixPart.toUpperCase();
      }
    } else if (isAllCapsMatch) {
      // No fullText available — fall back to rejecting
      continue;
    }

    // Reject Roman numeral suffixes
    const lastSpace = entityText.lastIndexOf(" ");
    const rawSuffix = lastSpace !== -1 ? entityText.slice(lastSpace + 1) : "";
    const suffixClean = rawSuffix.replace(/[.,]/g, "");
    if (suffixClean.length > 0 && ROMAN_NUMERAL_RE.test(suffixClean)) {
      continue;
    }

    // Short ASCII-only suffixes (NA, PA, LP, PC) are
    // US-specific. Reject if the prefix contains non-
    // ASCII chars (Czech/Slovak diacritics) — a US
    // legal entity wouldn't have "ÚČASTI MSP NA".
    // Test for dots in the raw suffix (before dot
    // stripping) to protect Czech dotted forms like
    // "a.s." and "k.s.".
    if (
      suffixClean.length <= 2 &&
      !/\./.test(rawSuffix) &&
      /[^\x00-\x7F]/.test(
        entityText.slice(0, lastSpace !== -1 ? lastSpace : entityText.length),
      )
    ) {
      continue;
    }

    // Definitive legal forms (s.r.o., a.s., GmbH, etc.)
    // get score 0.95 to beat person names in dedup.
    results.push({
      start: entityStart,
      end: entityStart + entityText.length,
      label: "organization",
      text: entityText,
      score: 0.95,
      source: DETECTION_SOURCES.LEGAL_FORM,
    });
  }

  return results;
};
