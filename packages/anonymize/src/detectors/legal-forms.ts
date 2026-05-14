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

import { LEGAL_SUFFIXES } from "../config/legal-forms";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { DASH_INNER } from "../util/char-groups";
import { loadLanguageConfigs } from "../util/lang-loader";

// Verb-like tokens that signal sentence context: when one of
// these appears between a role-head opening and the legal form,
// the match is a swept sentence fragment, not an organisation
// name. Names like "Client solutions Inc." or "Vendor consulting
// Ltd." don't contain any of these, so they pass through the
// trim untouched. Lowercased; matched case-insensitively.
//
// Sourced from `data/sentence-verb-indicators.json` (per-
// language so verb morphology stays next to other per-language
// data). Loaded lazily; the seed below covers the most common
// indicators across cs/en/de so the sync accessor keeps working
// before `warmSentenceVerbIndicators()` resolves.
const SENTENCE_VERB_INDICATORS_SEED: ReadonlySet<string> = new Set([
  "je",
  "jsou",
  "is",
  "are",
  "ist",
  "sind",
]);

let sentenceVerbIndicatorsCache: ReadonlySet<string> | null = null;
let sentenceVerbIndicatorsPromise: Promise<ReadonlySet<string>> | null = null;

const loadSentenceVerbIndicators = async (): Promise<ReadonlySet<string>> => {
  if (sentenceVerbIndicatorsCache) return sentenceVerbIndicatorsCache;
  if (sentenceVerbIndicatorsPromise) return sentenceVerbIndicatorsPromise;
  sentenceVerbIndicatorsPromise = (async () => {
    let data: Record<string, unknown> = {};
    try {
      const mod = await import("../data/sentence-verb-indicators.json");
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[anonymize] legal-forms: failed to load " +
          "sentence-verb-indicators.json, falling back " +
          "to seed list:",
        err,
      );
    }
    const all = new Set<string>(SENTENCE_VERB_INDICATORS_SEED);
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(value)) continue;
      for (const verb of value) {
        if (typeof verb !== "string" || verb.length === 0) continue;
        all.add(verb.toLowerCase());
      }
    }
    sentenceVerbIndicatorsCache = all;
    return all;
  })();
  return sentenceVerbIndicatorsPromise;
};

const getSentenceVerbIndicatorsSync = (): ReadonlySet<string> =>
  sentenceVerbIndicatorsCache ?? SENTENCE_VERB_INDICATORS_SEED;

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
  await Promise.all([
    loadLegalRoleHeads(),
    loadAllLegalSuffixes(),
    loadSentenceVerbIndicators(),
  ]);
};

// Suffix anchoring during the role-head trim needs the FULL
// legal-form vocabulary (not just the small `LEGAL_SUFFIXES`
// propagation list). "Vendor owns Acme Corp." has to anchor on
// "Corp." but `LEGAL_SUFFIXES` is Czech-leaning; load the same
// JSON the pattern builder uses and flatten it once.
let allLegalSuffixesCache: readonly string[] | null = null;
let allLegalSuffixesPromise: Promise<readonly string[]> | null = null;

const loadAllLegalSuffixes = async (): Promise<readonly string[]> => {
  if (allLegalSuffixesCache) return allLegalSuffixesCache;
  if (allLegalSuffixesPromise) return allLegalSuffixesPromise;
  allLegalSuffixesPromise = (async () => {
    let data: Record<string, string[]> = {};
    try {
      const mod = await import("../data/legal-forms.json");
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      data = (mod as { default: Record<string, string[]> }).default;
    } catch {
      data = {};
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of Object.values(data)) {
      for (const form of list) {
        if (typeof form !== "string" || form.length === 0) continue;
        if (seen.has(form)) continue;
        seen.add(form);
        out.push(form);
      }
    }
    for (const form of LEGAL_SUFFIXES) {
      if (!seen.has(form)) {
        seen.add(form);
        out.push(form);
      }
    }
    // Sort longest-first so multi-token suffixes like
    // "spol. s r.o." anchor before nested shorter forms.
    out.sort((a, b) => b.length - a.length);
    allLegalSuffixesCache = out;
    return out;
  })();
  return allLegalSuffixesPromise;
};

const getAllLegalSuffixesSync = (): readonly string[] =>
  allLegalSuffixesCache ?? LEGAL_SUFFIXES;

/**
 * Sync accessor for the full legal-form vocabulary
 * (`data/legal-forms.json` plus `LEGAL_SUFFIXES`,
 * longest-first). Falls back to `LEGAL_SUFFIXES` when
 * `warmLegalRoleHeads()` has not run yet. Exposed so the
 * trailing-period strip in `sanitizeEntities` can keep
 * pace with the detector vocabulary rather than only the
 * smaller `LEGAL_SUFFIXES` propagation list.
 */
export const getKnownLegalSuffixes = getAllLegalSuffixesSync;

// Common contract clause nouns that appear in legal prose
// between a sentence-verb and the company name. When the trim
// scans forward for the org's first Cap word, these are skipped
// like role-heads so we don't anchor on "Agreement" / "License"
// in patterns such as "Vendor signed Agreement with Acme Inc.".
const CLAUSE_NOUN_HEADS: ReadonlySet<string> = new Set([
  // English
  "agreement",
  "agreements",
  "contract",
  "contracts",
  "license",
  "licence",
  "lease",
  "memorandum",
  "notice",
  "exhibit",
  "schedule",
  "addendum",
  "amendment",
  "appendix",
  "attachment",
  // Czech
  "smlouva",
  "smlouvy",
  "smlouvu",
  "smlouvou",
  "dohoda",
  "dohody",
  "dohodu",
  "dohodou",
  "licence",
  "licenci",
  "příloha",
  "přílohy",
  "přílohu",
  "dodatek",
  "dodatku",
  "oznámení",
  // German
  "vertrag",
  "vertrages",
  "vereinbarung",
  "vereinbarungen",
  "lizenz",
  "anlage",
  "anhang",
]);

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
  // Tail allows up to 10 tokens so long state-form names
  // ("Národní agentura pro podporu rozvoje vzdělávání …, z.s.")
  // still match end-to-end. Sentence-fragment over-extension
  // is handled later by the role-head trim, not by tightening
  // this regex.
  const tail =
    `${SIMPLE_SEP}(?:${LOWER_WORD})` +
    `(?:(?:${LOWER_CONNECTOR}|${SIMPLE_SEP})(?:${ANY_WORD_TAIL})){0,10}`;
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
  // Bring `LEGAL_SUFFIXES` entries that aren't already in
  // `data/legal-forms.json` into the detector vocabulary too
  // — otherwise additions there only reach the propagation
  // and trailing-period passes, and the detector keeps
  // missing them on fresh prose ("Bank of America, N.A.").
  for (const form of LEGAL_SUFFIXES) {
    const key = form.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allForms.push(form);
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
  // Horizontal whitespace only ([ \t], not \s): SEC-style
  // signature blocks have heading markers ("AMENDMENT NO. 13
  // …\nNOVELIS SOUTH AMERICA HOLDINGS LLC") where allowing
  // newlines lets the prefix sweep across the heading into the
  // next-line LLC, then leaves residue like "TO SECOND" after
  // the role-head trim. Keeping the separator on-line confines
  // the pattern to a single physical line.
  const allcapPrefix =
    `(?:${ALLCAP_WORD})` +
    `(?:[ \\t&,.${DASH_INNER}]{1,4}(?:${ALLCAP_WORD})){0,2}`;
  const allcapAlt = allForms
    .toSorted((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");
  patterns.push(
    `${allcapPrefix}(?:[ \\t]+|,[ \\t]*)` + `(?:${allcapAlt})(?![${LOWER}])`,
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
    options.forceSuffixMode === true || COMPANY_SUFFIX_WORDS_RE.test(headWord);

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
    // role IF the match also contains a sentence-verb signal
    // ("owns", "je vlastníkem", "grants") between the role head
    // and the trailing legal-form suffix. Without that strong
    // signal we keep the match intact — role words are also
    // legitimate components of organisation names ("Client
    // Solutions Inc.", "Client solutions Inc.", "Vendor s.r.o.",
    // "Vendor consulting Ltd."). When the signal is present
    // we slice the match at the first uppercase-starting word
    // that follows the last sentence-verb (and skip any role-
    // head word that lands at the new start), so multi-word
    // names ("Acme Holdings s.r.o."), in-name prepositions
    // ("Bank of America Inc."), lowercase-tail Czech state
    // forms ("Národní agentura pro komunikační a informační
    // technologie, s. p."), and multi-token legal suffixes
    // ("spol. s r.o.") all survive the trim.
    const roleHeads = getLegalRoleHeadsSync();
    const firstWordMatch = /^[\p{L}\p{M}]+/u.exec(text);
    let processedStart = match.start;
    let processedText = text;
    // True when the role-head trim slices the match. The
    // subsequent extendBackward step is suppressed in that case
    // — extending back would re-absorb the very prose the trim
    // just removed (e.g. "Vendor grants Licensee Acme Inc." →
    // trim to "Acme Inc." → extendBackward walks back across
    // "Licensee" again and emits "Licensee Acme Inc.").
    let trimmed = false;
    if (
      firstWordMatch !== null &&
      roleHeads.has(firstWordMatch[0].toLowerCase())
    ) {
      // Find the legal-form suffix's position inside `text` by
      // scanning the full legal-form vocabulary (loaded from
      // `data/legal-forms.json` in `warmLegalRoleHeads`-style
      // fashion). Sorted longest-first so multi-token suffixes
      // ("spol. s r.o.", "akciová společnost") anchor before
      // shorter nested forms ("s.r.o.", "společnost").
      let suffixOffset = -1;
      for (const suffix of getAllLegalSuffixesSync()) {
        const idx = text.lastIndexOf(suffix);
        if (idx !== -1 && idx + suffix.length >= text.length - 1) {
          suffixOffset = idx;
          break;
        }
      }
      if (suffixOffset < 0) {
        // Couldn't locate the suffix; fall through without
        // trimming. The greedy regex will still produce the
        // match — better some highlight than none.
      } else {
        // Scan the middle (between the role-head and the legal-
        // form suffix) for a sentence-verb token. Position of
        // the LAST verb determines where the org name starts.
        const midStart = firstWordMatch[0].length;
        const midEnd = suffixOffset;
        const midSection = text.slice(midStart, midEnd);
        const verbIndicators = getSentenceVerbIndicatorsSync();
        let lastVerbEndInMid = -1;
        for (const match of midSection.matchAll(
          // Match any word (capital or lowercase start); the
          // verb-indicator set lookup is lowercased so e.g.
          // title-cased "Owns" in "Vendor Owns Acme Inc."
          // still counts as a sentence verb.
          /(?<![\p{L}\p{N}])[\p{L}\p{M}]+/gu,
        )) {
          if (
            match[0] !== undefined &&
            match.index !== undefined &&
            verbIndicators.has(match[0].toLowerCase())
          ) {
            lastVerbEndInMid = match.index + match[0].length;
          }
        }
        // Also treat a digit immediately after the role-head
        // ("Vendor 1", "Prodávající 2") as a sentence signal.
        // Numbered party references rarely appear in company
        // names but always appear in clause text.
        const digitAfterRole = /^\s+\d+(?:\.|\b)/u.test(midSection);
        // Appositive role-head detection: when the legal-form
        // regex matched a span starting at a role-head ("Licensee
        // Acme Inc.") but there's no verb in the matched mid
        // section, look at the preceding word in fullText. If
        // that word is a sentence verb ("Vendor grants Licensee
        // Acme Inc."), the role-head is appositive prose and
        // should be skipped just like an in-match role token.
        let appositiveRoleHead = false;
        if (!digitAfterRole && lastVerbEndInMid === -1 && fullText) {
          const before = fullText.slice(
            Math.max(0, match.start - 40),
            match.start,
          );
          const prevWord = /(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{M}]*)\s*$/u.exec(
            before,
          );
          if (
            prevWord !== null &&
            getSentenceVerbIndicatorsSync().has(prevWord[1]!.toLowerCase())
          ) {
            appositiveRoleHead = true;
          }
        }
        if (lastVerbEndInMid !== -1 || digitAfterRole || appositiveRoleHead) {
          // Pick the first Cap-starting word in `text` after
          // the last verb (or, if only a digit signal fired,
          // after the role-head itself). Skip role-heads
          // ("Vendor grants Licensee Acme Inc.") and clause
          // nouns ("Vendor signed Agreement with Acme Inc.")
          // so the anchor lands on the real company name.
          // When trim was triggered by an appositive role-head
          // (no in-match verb), the role-head itself is the
          // thing to skip — scan starts from after the role
          // head's first word.
          const scanStart =
            lastVerbEndInMid !== -1 ? midStart + lastVerbEndInMid : midStart;
          const capRe = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}\p{N}]*/gu;
          capRe.lastIndex = scanStart;
          let capMatch: RegExpExecArray | null = null;
          for (
            let next = capRe.exec(text);
            next !== null;
            next = capRe.exec(text)
          ) {
            if (next.index >= suffixOffset) {
              break;
            }
            const lc = next[0].toLowerCase();
            if (roleHeads.has(lc) || CLAUSE_NOUN_HEADS.has(lc)) {
              continue;
            }
            capMatch = next;
            break;
          }
          if (capMatch === null) {
            // No real cap-word before the suffix; drop.
            continue;
          }
          processedStart = match.start + capMatch.index;
          processedText = text.slice(capMatch.index);
          trimmed = true;
        }
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
    if (fullText && !trimmed) {
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
