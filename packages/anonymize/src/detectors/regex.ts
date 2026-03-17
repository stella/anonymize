import { RegexSet } from "@stll/regex-set";

import { POST_NOMINALS, TITLE_PREFIXES } from "../config/titles";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

const MIN_PHONE_LENGTH = 7;

// ── Shared helpers ──────────────────────────────────

const escapeTitle = (title: string): string =>
  title
    // eslint-disable-next-line no-useless-escape
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");

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
const UPPER_CZ = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ";
// biome-ignore lint/security/noSecrets: diacritics char class
const LOWER_CZ = "a-záčďéěíňóřšťúůýžäöüß";
const NAME_WORD = `[${UPPER_CZ}][${LOWER_CZ}]+`;

const PARTICLE =
  `(?:van der|van den|de la|della|` +
  `von|van|dos|ibn|ben|bin|del|zum|zur|ten|ter|` +
  `da|de|di|al|el|le|la|zu|af|av)`;

// Non-newline whitespace
const SP = "[^\\S\\n\\t]";

// ── Pattern metadata ────────────────────────────────
// Parallel arrays: PATTERNS[i] ↔ META[i]
// Indexed by match.pattern for O(1) lookup.

type PatternMeta = {
  label: string;
  score: number;
};

/**
 * All PII regex patterns. Scanned in a single pass
 * by @stll/regex-set (Rust regex-automata DFA).
 *
 * To add a new pattern: append to PATTERNS and META.
 * The index must match.
 */
const PATTERNS: string[] = [
  // 0: titled person (Czech/German)
  `(?:${TITLE_PREFIX})` +
    `(?:${SP}+(?:${TITLE_PREFIX}))*` +
    `${SP}+` +
    `(?:${NAME_WORD})` +
    `(?:${SP}{1,4}(?:${PARTICLE}${SP}+)?${NAME_WORD}){1,3}` +
    `(?:,?${SP}+(?:${POST_NOMINAL}))?`,
  // 1: English honorific person
  `(?:M\\.|Mrs|Ms|Miss|Messrs|Mr|Sir|Dame|Lord|Lady|` +
    `Judge|Justice|President|Mme|Mlle|Me|Maître)` +
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
  // 6: domestic CZ/SK landline phone (2xx-5xx)
  `\\b[2-5]\\d{2}[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{3}` +
    `(?![\\s.\\-]?\\d*/\\d)\\b`,
  // 8: credit card
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
  // 10: Czech written-month "1. ledna 2025"
  `\\b\\d{1,2}\\.\\s+(?:ledna|února|března|dubna|` +
    `května|června|července|srpna|září|října|` +
    `listopadu|prosince)\\s+\\d{4}\\b`,
  // 11: German written-month "1. Januar 2025"
  `(?i)\\b\\d{1,2}\\.\\s+(?:Januar|Februar|März|` +
    `April|Mai|Juni|Juli|August|September|Oktober|` +
    `November|Dezember)\\s+\\d{4}\\b`,
  // 12: English written-month "13 July 1989"
  `(?i)\\b\\d{1,2}\\s+(?:January|February|March|` +
    `April|May|June|July|August|September|October|` +
    `November|December)\\s+\\d{4}\\b`,
  // 13: English month+year "October 1983"
  `(?i)\\b(?:January|February|March|April|May|June|` +
    `July|August|September|October|November|` +
    `December)\\s+\\d{4}\\b`,
  // 14: ordinal English dates "1st January 2025"
  `(?i)\\b\\d{1,2}(?:st|nd|rd|th)\\s+(?:January|` +
    `February|March|April|May|June|July|August|` +
    `September|October|November|December)` +
    `(?:\\s+\\d{4})?\\b`,
  // 15: IP address
  `\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}` +
    `(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b`,
  // 16: Czech bank account (optional prefix)
  `\\b(?:\\d{1,6}-)?\\d{6,10}/\\d{4}(?!\\d)`,
];

/** Parallel metadata. Index = pattern index. */
const META: readonly PatternMeta[] = [
  { label: "person", score: 0.95 },
  { label: "person", score: 0.95 },
  { label: "iban", score: 1 },
  { label: "email address", score: 1 },
  { label: "phone number", score: 1 },
  { label: "phone number", score: 0.9 },
  { label: "phone number", score: 0.7 },
  { label: "credit card number", score: 1 },
  { label: "czech birth number", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "date", score: 1 },
  { label: "ip address", score: 1 },
  { label: "bank account number", score: 0.95 },
];

// ── Cached RegexSet instance ────────────────────────

let cached: RegexSet | null = null;

const getRegexSet = (): RegexSet => {
  if (!cached) {
    cached = new RegexSet(PATTERNS);
  }
  return cached;
};

// ── Company ID keyword patterns ─────────────────────
// Capture groups for value extraction require JS
// RegExp (regex-set doesn't expose capture groups).

type CompanyIdKeyword = {
  label:
    | "registration number"
    | "tax identification number";
  keywords: readonly string[];
};

const COMPANY_ID_GROUPS: readonly CompanyIdKeyword[] = [
  {
    label: "registration number",
    keywords: [
      "IČO",
      "IČ",
      "identifikační číslo",
      "registrační číslo",
      "registration number",
      "company id",
      "company number",
      "Handelsregisternummer",
      "Handelsregister",
      "HRB",
      "Registernummer",
      "SIREN",
      "SIRET",
      "partita IVA",
      "codice fiscale",
      "UID",
    ],
  },
  {
    label: "tax identification number",
    keywords: [
      "DIČ",
      "daňové identifikační číslo",
      "VAT number",
      "VAT ID",
      "tax identification number",
      "tax id",
      "Steuernummer",
      "Steuer-Nr.",
      "USt-IdNr.",
      "USt-IdNr",
      "NIP",
      "CIF",
      "NIF",
      "BTW",
    ],
  },
];

const COMPANY_ID_SCORE = 0.95;

type CompanyIdPattern = {
  label: string;
  pattern: RegExp;
  score: number;
};

const buildCompanyIdPatterns = (): CompanyIdPattern[] => {
  const patterns: CompanyIdPattern[] = [];
  for (const group of COMPANY_ID_GROUPS) {
    const sorted = group.keywords.toSorted(
      (a, b) => b.length - a.length,
    );
    const keywordAlt = sorted
      .map(escapeTitle)
      .join("|");
    const re = new RegExp(
      `(?<!\\p{L})(?:${keywordAlt})(?:\\s*:\\s*|\\s+)` +
        `([A-Z]{0,4}\\s?\\d[\\d\\s\\-/]{4,})`,
      "giu",
    );
    patterns.push({
      label: group.label,
      pattern: re,
      score: COMPANY_ID_SCORE,
    });
  }
  return patterns;
};

const COMPANY_ID_PATTERNS = buildCompanyIdPatterns();

// ── Public API ──────────────────────────────────────

/**
 * Run regex-based PII detection. Uses @stll/regex-set
 * for a single-pass DFA scan of all PII patterns.
 * Company ID keyword patterns remain as JS RegExp
 * (capture group extraction).
 */
export const detectRegexPii = (
  fullText: string,
): Entity[] => {
  const results: Entity[] = [];
  const rs = getRegexSet();

  // Single-pass regex-set scan
  for (const match of rs.findIter(fullText)) {
    const meta = META[match.pattern];
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

  // Company ID keyword patterns (capture groups)
  for (const {
    label,
    pattern,
    score,
  } of COMPANY_ID_PATTERNS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(fullText);
      match !== null;
      match = pattern.exec(fullText)
    ) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      const valueIdx =
        match.index + match[0].lastIndexOf(value);
      results.push({
        start: valueIdx,
        end: valueIdx + value.length,
        label,
        text: value,
        score,
        source: DETECTION_SOURCES.REGEX,
      });
    }
  }

  return results;
};
