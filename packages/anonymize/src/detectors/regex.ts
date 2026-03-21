import type { Match } from "@stll/text-search";

import { POST_NOMINALS, TITLE_PREFIXES } from "../config/titles";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

const MIN_PHONE_LENGTH = 7;
const MIN_MONTH_NAME_LENGTH = 3;

// ── Shared helpers ──────────────────────────────────

const escapeTitle = (title: string): string =>
  title
    // eslint-disable-next-line no-useless-escape
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");

/** Escape for use inside a regex alternation. */
const escapeRegex = (s: string): string =>
  // eslint-disable-next-line no-useless-escape
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TITLE_PREFIX = TITLE_PREFIXES.toSorted(
  (a, b) => b.length - a.length,
)
  .map(escapeTitle)
  .join("|");

const POST_NOMINAL = POST_NOMINALS.toSorted(
  (a, b) => b.length - a.length,
)
  .map(escapeTitle)
  .join("|");

// biome-ignore lint/security/noSecrets: diacritics char class
const UPPER_EXTENDED = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÀÈÌÒÙ";
// biome-ignore lint/security/noSecrets: diacritics char class
const LOWER_EXTENDED = "a-záčďéěíňóřšťúůýžäöüßàèìòù";
const NAME_WORD = `[${UPPER_EXTENDED}][${LOWER_EXTENDED}]+`;

const PARTICLE =
  `(?:van der|van den|de la|della|` +
  `von|van|dos|ibn|ben|bin|del|zum|zur|ten|ter|` +
  `da|de|di|al|el|le|la|zu|af|av)`;

// Non-newline whitespace
const SP = "[^\\S\\n\\t]";

// ── Pattern metadata ────────────────────────────────
// Parallel arrays: PATTERNS[i] ↔ META[i]
// Indexed by match.pattern for O(1) lookup.

export type RegexMeta = {
  label: string;
  score: number;
};

/**
 * Static PII regex patterns. Scanned in a single pass
 * by @stll/regex-set (Rust regex-automata DFA).
 *
 * Date patterns using written month names are built
 * dynamically from date-months.json via
 * `getDatePatterns()`.
 */
export const REGEX_PATTERNS: readonly string[] = [
  // 0: titled person (Czech/German)
  `(?:${TITLE_PREFIX})` +
    `(?:${SP}+(?:${TITLE_PREFIX}))*` +
    `${SP}+` +
    `(?:${NAME_WORD})` +
    `(?:${SP}{1,4}(?:${PARTICLE}${SP}+)?${NAME_WORD}){1,3}` +
    `(?:,?${SP}+(?:${POST_NOMINAL}))?`,
  // 1: English honorific person
  `(?:\\bM\\.|Mrs|Ms|Miss|Messrs|Mr|Sir|Dame|Lord|Lady|` +
    `Judge|Justice|President|Mme|Mlle|\\bMe\\b|Maître)` +
    `\\.?${SP}+[A-Z][a-z]+` +
    `(?:(?:${SP}|-){1,2}(?:${PARTICLE}${SP}+)?` +
    `[A-Z][a-z]+){0,3}` +
    `(?:${SP}+(?:QC|KC|SC|LJ|AG))?`,
  // 2: IBAN
  `\\b[A-Z]{2}\\d{2}\\s?[\\dA-Z]{4}\\s?[\\dA-Z]{4}` +
    `\\s?[\\dA-Z]{4}\\s?[\\dA-Z]{4}` +
    `\\s?[\\dA-Z]{0,14}\\b`,
  // 3: email
  `\\b[\\w.+\\-]+@[\\w\\-]+(?:\\.[\\w\\-]+)+\\b`,
  // 4: international phone
  `\\+\\d{1,3}[\\s.\\-]?\\(?\\d{2,4}\\)?` +
    `[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{2,4}` +
    `[\\s.\\-]?\\d{0,4}\\b`,
  // 5: domestic CZ/SK mobile phone (6xx/7xx)
  `\\b[67]\\d{2}[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{3}` +
    `(?![\\s.\\-]?\\d*/\\d)\\b`,
  // 6: credit card
  `\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2})` +
    `[\\s.\\-]?\\d{4}[\\s.\\-]?\\d{4}` +
    `[\\s.\\-]?\\d{2,4}\\b`,
  // 7: czech birth number
  `\\b\\d{6}/\\d{3,4}\\b`,
  // 8: date DD.MM.YYYY or YYYY-MM-DD
  `\\b(?:\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}` +
    `|\\d{4}-\\d{2}-\\d{2})\\b`,
  // 9: Czech spaced dates "1. 1. 2025"
  `\\b\\d{1,2}\\.\\s+\\d{1,2}\\.\\s+\\d{4}\\b`,
  // 10: monetary amount (leading symbol)
  `(?:[$€£¥₽])[^\\S\\n\\t]?\\d{1,3}(?:[,.\'[^\\S\\n\\t]]\\d{3})*(?:[.,]\\d{1,2})?\\b`,
  // 11: monetary amount (trailing code)
  `\\b\\d{1,3}(?:[,.\'[^\\S\\n\\t]]\\d{3})*(?:[.,]\\d{2})?[^\\S\\n\\t]?` +
    `(?:USD|EUR|GBP|CZK|PLN|HUF|CHF|SEK|NOK|DKK|RON|JPY|CNY)\\b`,
  // 12: IP address
  `\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}` +
    `(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b`,
  // 13: Czech bank account (optional prefix)
  `\\b(?:\\d{1,6}-)?\\d{6,10}/\\d{4}(?!\\d)`,
  // 14: Hungarian Budapest landline (+36 1 XXX XXXX)
  // 2+ digit area codes handled by pattern 4 (international)
  `\\+36[\\s.\\-]?1[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{4}\\b`,
  // 15: Hungarian adószám (tax ID)
  `\\b\\d{8}-\\d-\\d{2}\\b`,
  // 16: Italian codice fiscale
  `\\b[A-Z]{6}\\d{2}[A-Z]\\d{2}[A-Z]\\d{3}[A-Z]\\b`,
  // 17: Spanish DNI
  `\\b\\d{2}\\.?\\d{3}\\.?\\d{3}-?[A-Z]\\b`,
  // 18: Spanish NIE
  `\\b[XYZ]-?\\d{7}-?[A-Z]\\b`,
  // 19: Swedish personnummer (12-digit)
  `\\b\\d{8}-\\d{4}\\b`,
  // 20: Romanian CNP
  `\\b[1-8]\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{6}\\b`,
  // 21: French NIR (social security)
  `\\b[12]\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}\\b`,
];

/** Parallel metadata. Index = pattern index. */
export const REGEX_META: readonly RegexMeta[] = [
  { label: "person", score: 0.95 },
  { label: "person", score: 0.95 },
  { label: "iban", score: 1 },
  { label: "email address", score: 1 },
  { label: "phone number", score: 1 },
  { label: "phone number", score: 0.9 },
  { label: "credit card number", score: 1 },
  { label: "czech birth number", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "monetary amount", score: 0.9 },
  { label: "monetary amount", score: 0.9 },
  { label: "ip address", score: 1 },
  { label: "bank account number", score: 0.95 },
  { label: "phone number", score: 0.9 },
  { label: "tax identification number", score: 0.95 },
  { label: "tax identification number", score: 1 },
  { label: "national identification number", score: 1 },
  { label: "national identification number", score: 1 },
  { label: "national identification number", score: 1 },
  { label: "national identification number", score: 1 },
  { label: "social security number", score: 1 },
];

// ── Dynamic date patterns (22 languages) ────────────

/**
 * JSON shape: language codes map to string arrays;
 * metadata keys (prefixed `_`) map to strings.
 * The `_` keys are skipped by `buildMonthAlternation`.
 */
type DateMonths = Record<string, string[] | string>;

/**
 * Build month-name alternation from date-months.json.
 * Deduplicates across all 22 languages, filters names
 * shorter than 3 chars (too many false positives), and
 * sorts longest-first so the regex engine prefers the
 * longest match.
 */
const buildMonthAlternation = (
  months: DateMonths,
): string => {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(months)) {
    if (key.startsWith("_")) continue;
    const names = Array.isArray(value) ? value : [value];
    for (const name of names) {
      // Strip trailing dots for the regex; date patterns
      // use `\\.?` after the alternation to match optional
      // abbreviation dots.
      const clean = name
        .replace(/\.$/, "")
        .toLowerCase();
      if (clean.length >= MIN_MONTH_NAME_LENGTH) {
        seen.add(clean);
      }
    }
  }
  return [...seen]
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
};

/**
 * Build date patterns from a month-name alternation.
 * Returns 6 patterns covering the major written-date
 * formats across all supported languages.
 */
const buildDatePatternsFromMonths = (
  alt: string,
): string[] => {
  if (!alt) {
    // No month names survived filtering — return nothing
    // rather than emitting patterns with (?:) that match
    // arbitrary whitespace.
    return [];
  }
  return [
  // a. DD[.] Month[.] YYYY — "1. ledna 2025", "17 Sep. 2023"
  `(?i)\\b\\d{1,2}\\.?\\s+(?:${alt})\\.?\\s+\\d{4}\\b`,
  // b. Month[.] DD[,] YYYY — "March 7, 2023" (US format)
  `(?i)\\b(?:${alt})\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b`,
  // c. DDst/nd/rd/th Month[.] [YYYY] — "1st January 2025"
  `(?i)\\b\\d{1,2}(?:st|nd|rd|th)\\s+(?:${alt})\\.?` +
    `(?:\\s+\\d{4})?(?=\\s|[.,;!?)]|$)`,
  // d. Month[.] YYYY — "October 1983"
  `(?i)\\b(?:${alt})\\.?\\s+\\d{4}\\b`,
  // e. YYYY. Month[.] DD. — Hungarian "2025. január 7."
  `(?i)\\b\\d{4}\\.\\s+(?:${alt})\\.?\\s+\\d{1,2}\\.?(?=\\s|[.,;!?)]|$)`,
  // f. DD de Month[.] [de] YYYY — Spanish "7 de enero de 2025"
  `(?i)\\b\\d{1,2}\\s+de\\s+(?:${alt})\\.?` +
    `(?:\\s+de)?\\s+\\d{4}\\b`,
  ];
};

/** Cached promise for date patterns. Loaded once. */
let datePatternPromise: Promise<string[]> | null = null;

const loadDatePatterns = async (): Promise<string[]> => {
  const mod = await import(
    "@stll/anonymize-data/config/date-months.json"
  );
  // Dynamic import of JSON returns { default, ...keys }.
  // Use `default` if present (ESM wrapper), else the
  // module itself.
  const months: DateMonths = mod.default ?? mod;
  const alt = buildMonthAlternation(months);
  return buildDatePatternsFromMonths(alt);
};

/**
 * Get dynamically built date patterns from
 * date-months.json. Returns a cached promise; the JSON
 * is loaded only once.
 */
export const getDatePatterns = (): Promise<string[]> => {
  if (!datePatternPromise) {
    datePatternPromise = loadDatePatterns().catch(
      (err) => {
        datePatternPromise = null;
        throw err;
      },
    );
  }
  return datePatternPromise;
};

/** Date pattern metadata (all are score 1 dates). */
export const DATE_PATTERN_META: Readonly<RegexMeta> =
  Object.freeze({
    label: "date",
    score: 1,
  });

// ── Public API ──────────────────────────────────────

/**
 * Process regex matches from the unified search.
 * Receives all matches; filters to the regex slice
 * via sliceStart/sliceEnd. Local index into META is
 * match.pattern - sliceStart.
 */
export const processRegexMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const localIdx = idx - sliceStart;
    const meta = REGEX_META[localIdx];
    if (!meta) {
      continue;
    }
    if (
      meta.label === "phone number" &&
      match.text.length < MIN_PHONE_LENGTH
    ) {
      continue;
    }
    results.push({
      start: match.start,
      end: match.end,
      label: meta.label,
      text: match.text,
      score: meta.score,
      source: DETECTION_SOURCES.REGEX,
    });
  }

  return results;
};
