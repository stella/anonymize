import type { Match } from "@stll/text-search";
import type { Validator } from "@stll/stdnum";
import {
  at, be, bg, cz, cy, de, dk, ee, es,
  fi, fr, gb, gr, hr, hu, ie, it, lt,
  lu, lv, mt, nl, pl, pt, ro, se, si,
  sk,
} from "@stll/stdnum";
import { toRegex } from "@stll/stdnum/patterns";

import {
  HONORIFIC_BOUNDARY,
  HONORIFICS,
  POST_NOMINALS,
  TITLE_PREFIXES,
} from "../config/titles";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { DASH } from "../util/char-groups";

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

/** Escape for use inside a regex character class. */
const escapeCharClass = (s: string): string =>
  s.replace(/[\]\\^-]/g, "\\$&");

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

/** Honorific alternation built from titles.ts config. */
const HONORIFIC_ALT = [...HONORIFICS]
  .toSorted((a, b) => b.length - a.length)
  .map((h) => {
    const escaped = escapeRegex(h);
    return HONORIFIC_BOUNDARY.has(h)
      ? `\\b${escaped}`
      : escaped;
  })
  .join("|");

// ── Pattern definitions ─────────────────────────────

export type RegexMeta = {
  label: string;
  score: number;
  /** Post-match stdnum validator for confirmation. */
  validator?: Validator;
};

type RegexDef = {
  pattern: string;
  label: string;
  score: number;
  validator?: Validator;
};

// ── stdnum validator entries ────────────────────────
// Each entry pairs a @stll/stdnum validator with a
// label and confidence score. The pattern derived via
// toRegex(validator).source is used as the regex; the
// validator itself is stored in META for post-match
// confirmation (see processRegexMatches).

type StdnumEntry = {
  validator: Validator;
  label: string;
  score: number;
  pattern: string;
};

const toEntry = (
  validator: Validator,
  label: string,
  score: number,
): StdnumEntry | null => {
  const pattern = toRegex(validator).source;
  if (!pattern) return null;
  return {
    validator,
    label,
    score,
    pattern,
  };
};

/**
 * Stdnum validators for national/company IDs.
 *
 * Selection criteria: only patterns specific enough
 * to avoid excessive false positives (country-prefixed
 * VAT numbers, structured personal IDs). Generic
 * digit-only patterns (e.g. \d{8}) are excluded unless
 * the validator's checksum is strong enough to filter.
 */
const STDNUM_ENTRIES: readonly StdnumEntry[] = [
  // ── Original PR #28 patterns (were 15-21) ────────
  toEntry(hu.vat, "tax identification number", 0.95),
  toEntry(
    it.codiceFiscale,
    "national identification number",
    0.95,
  ),
  toEntry(
    es.dni,
    "national identification number",
    0.9,
  ),
  toEntry(
    es.nie,
    "national identification number",
    0.95,
  ),
  toEntry(
    se.personnummer,
    "national identification number",
    0.9,
  ),
  toEntry(ro.cnp, "national identification number", 0.95),
  toEntry(fr.nir, "social security number", 0.9),

  // ── CZ validators ────────────────────────────────
  toEntry(cz.dic, "tax identification number", 0.95),
  // cz.ico and cz.rc omitted: cz.ico is \d{8} (too
  // generic), cz.rc is \d{6}/\d{3,4} (handled by
  // pattern 7: czech birth number)

  // ── DE validators ────────────────────────────────
  toEntry(de.vat, "tax identification number", 0.95),
  toEntry(
    de.idnr,
    "tax identification number",
    0.9,
  ),
  toEntry(
    de.stnr,
    "tax identification number",
    0.9,
  ),
  toEntry(
    de.svnr,
    "social security number",
    0.9,
  ),

  // ── PL validators ────────────────────────────────
  toEntry(pl.nip, "tax identification number", 0.95),
  toEntry(
    pl.pesel,
    "national identification number",
    0.9,
  ),
  // pl.regon omitted: \d{9,14} too generic

  // ── GB validators ────────────────────────────────
  toEntry(gb.vat, "tax identification number", 0.95),
  toEntry(
    gb.nino,
    "social security number",
    0.95,
  ),
  // gb.utr omitted: \d{10} too generic

  // ── AT validators ────────────────────────────────
  toEntry(at.uid, "tax identification number", 0.95),
  toEntry(
    at.tin,
    "tax identification number",
    0.9,
  ),
  toEntry(
    at.businessid,
    "registration number",
    0.95,
  ),

  // ── BE validators ────────────────────────────────
  toEntry(be.vat, "tax identification number", 0.95),
  toEntry(
    be.nn,
    "national identification number",
    0.9,
  ),

  // ── NL validators ────────────────────────────────
  toEntry(nl.vat, "tax identification number", 0.95),
  // nl.bsn omitted: \d{9} too generic

  // ── DK validators ────────────────────────────────
  toEntry(dk.vat, "tax identification number", 0.95),
  toEntry(
    dk.cpr,
    "national identification number",
    0.9,
  ),

  // ── FI validators ────────────────────────────────
  toEntry(fi.vat, "tax identification number", 0.95),
  toEntry(
    fi.hetu,
    "national identification number",
    0.95,
  ),
  toEntry(fi.ytunnus, "registration number", 0.9),

  // ── BG validators ────────────────────────────────
  toEntry(bg.vat, "tax identification number", 0.95),

  // ── SK validators ────────────────────────────────
  toEntry(sk.dic, "tax identification number", 0.95),
  // sk.ico: \d{8} too generic; sk.rc overlaps with
  // czech birth number pattern

  // ── ES additional validators ─────────────────────
  toEntry(es.cif, "registration number", 0.95),
  toEntry(es.vat, "tax identification number", 0.95),
  toEntry(es.nss, "social security number", 0.9),

  // ── FR additional validators ─────────────────────
  toEntry(fr.tva, "tax identification number", 0.95),
  toEntry(fr.siren, "registration number", 0.9),
  toEntry(fr.siret, "registration number", 0.9),

  // ── IT additional validators ─────────────────────
  toEntry(it.iva, "tax identification number", 0.95),

  // ── IE validators ────────────────────────────────
  toEntry(ie.vat, "tax identification number", 0.95),
  toEntry(
    ie.pps,
    "national identification number",
    0.9,
  ),

  // ── PT validators ────────────────────────────────
  toEntry(pt.vat, "tax identification number", 0.95),
  toEntry(
    pt.cc,
    "national identification number",
    0.9,
  ),

  // ── RO additional validators ─────────────────────
  toEntry(ro.vat, "tax identification number", 0.95),

  // ── GR validators ────────────────────────────────
  toEntry(gr.vat, "tax identification number", 0.95),

  // ── HR validators ────────────────────────────────
  toEntry(hr.vat, "tax identification number", 0.95),

  // ── SI validators ────────────────────────────────
  toEntry(si.vat, "tax identification number", 0.95),

  // ── LT validators ────────────────────────────────
  toEntry(lt.vat, "tax identification number", 0.95),
  toEntry(
    lt.asmens,
    "national identification number",
    0.9,
  ),

  // ── LV validators ────────────────────────────────
  toEntry(lv.vat, "tax identification number", 0.95),

  // ── EE validators ────────────────────────────────
  toEntry(ee.vat, "tax identification number", 0.95),
  toEntry(
    ee.ik,
    "national identification number",
    0.9,
  ),

  // ── CY validators ────────────────────────────────
  toEntry(cy.vat, "tax identification number", 0.95),

  // ── MT validators ────────────────────────────────
  toEntry(mt.vat, "tax identification number", 0.95),

  // ── LU validators ────────────────────────────────
  toEntry(lu.vat, "tax identification number", 0.95),
].filter((e): e is StdnumEntry => e !== null);

// ── Named pattern definitions ────────────────────────

const TITLED_PERSON: RegexDef = {
  pattern:
    `(?:${TITLE_PREFIX})` +
    `(?:${SP}+(?:${TITLE_PREFIX}))*` +
    `${SP}+` +
    `(?:${NAME_WORD})` +
    `(?:${SP}{1,4}(?:${PARTICLE}${SP}+)?` +
    `${NAME_WORD}){1,3}` +
    `(?:,?${SP}+(?:${POST_NOMINAL})(?:,?${SP}+(?:${POST_NOMINAL}))*)?`,
  label: "person",
  score: 0.95,
};

const HONORIFIC_PERSON: RegexDef = {
  pattern:
    `(?:${HONORIFIC_ALT})` +
    `\\.?${SP}+${NAME_WORD}` +
    `(?:(?:${SP}|-){1,2}(?:${PARTICLE}${SP}+)?` +
    `${NAME_WORD}){0,3}` +
    `(?:${SP}+(?:QC|KC|SC|LJ|AG))?`,
  label: "person",
  score: 0.95,
};

const IBAN: RegexDef = {
  pattern:
    `\\b[A-Z]{2}\\d{2}\\s?[\\dA-Z]{4}\\s?[\\dA-Z]{4}` +
    `\\s?[\\dA-Z]{4}\\s?[\\dA-Z]{4}` +
    `\\s?[\\dA-Z]{0,14}\\b`,
  label: "iban",
  score: 1,
};

const EMAIL: RegexDef = {
  pattern:
    `\\b[\\w.+\\-]+@[\\w\\-]+(?:\\.[\\w\\-]+)+\\b`,
  label: "email address",
  score: 1,
};

// [^\S\n] instead of \s: separators must not
// match newlines (prevents cross-line bleeding).
const INTL_PHONE: RegexDef = {
  pattern:
    `\\+\\d{1,3}(?:[^\\S\\n]|[.\\-])?\\(?\\d{2,4}\\)?` +
    `(?:[^\\S\\n]|[.\\-])?\\d{3}(?:[^\\S\\n]|[.\\-])?\\d{2,4}` +
    `(?:[^\\S\\n]|[.\\-])?\\d{0,4}\\b`,
  label: "phone number",
  score: 1,
};

// Czech phone numbers: mobiles start with 6/7,
// landlines with 2-5. Restrict to [2-7] but require
// the full 9-digit pattern to avoid matching monetary
// amounts. The negative lookahead prevents bank
// account patterns (digits/digits).
const CZ_PHONE: RegexDef = {
  pattern:
    `\\b[2-7]\\d{2}(?:[^\\S\\n]|[.\\-])?\\d{3}` +
    `(?:[^\\S\\n]|[.\\-])?\\d{3}` +
    `(?!(?:[^\\S\\n]|[.\\-])?\\d*/\\d)` +
    `(?![^\\S\\n]*(?:Kč|,-|korun|EUR|USD|€|\\$))\\b`,
  label: "phone number",
  score: 0.85,
};

/**
 * Phone numbers prefixed with "tel.:" or "telefon:".
 * Captures the number after the prefix, including
 * optional international code (+420).
 */
const TEL_PREFIX_PHONE: RegexDef = {
  pattern:
    `(?:\\b[Tt]el(?:efon)?\\.?\\s*:?\\s*)` +
    `(?:\\+?\\d{1,3}[^\\S\\n]?)?` +
    `\\d{3}(?:[^\\S\\n]|[.\\-])?\\d{3}` +
    `(?:[^\\S\\n]|[.\\-])?\\d{3}\\b`,
  label: "phone number",
  score: 0.95,
};

const CREDIT_CARD: RegexDef = {
  pattern:
    `\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2})` +
    `(?:[^\\S\\n]|[.\\-])?\\d{4}(?:[^\\S\\n]|[.\\-])?\\d{4}` +
    `(?:[^\\S\\n]|[.\\-])?\\d{2,4}\\b`,
  label: "credit card number",
  score: 1,
};

const CZ_BIRTH_NUMBER: RegexDef = {
  pattern: `\\b\\d{6}/\\d{3,4}\\b`,
  label: "czech birth number",
  score: 1,
  validator: cz.rc,
};

const DATE_NUMERIC: RegexDef = {
  pattern:
    `\\b(?:\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}` +
    `|\\d{4}-\\d{2}-\\d{2}` +
    `|\\d{4}\\.\\d{2}\\.\\d{2})\\b`,
  label: "date",
  score: 1,
};

const DATE_CZ_SPACED: RegexDef = {
  pattern:
    `\\b\\d{1,2}\\.[^\\S\\n]+\\d{1,2}\\.[^\\S\\n]+\\d{4}\\b`,
  label: "date",
  score: 1,
};

const IP_ADDRESS: RegexDef = {
  pattern:
    `\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}` +
    `(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b`,
  label: "ip address",
  score: 1,
};

const CZ_BANK_ACCOUNT: RegexDef = {
  pattern:
    `\\b(?:\\d{1,6}-)?\\d{6,10}/\\d{4}(?!\\d)`,
  label: "bank account number",
  score: 0.95,
};

// Hungarian Budapest landline (+36 1 XXX XXXX).
// 2+ digit area codes handled by INTL_PHONE.
const HU_LANDLINE: RegexDef = {
  pattern:
    `\\+36(?:[^\\S\\n]|[.\\-])?1(?:[^\\S\\n]|[.\\-])?\\d{3}` +
    `(?:[^\\S\\n]|[.\\-])?\\d{4}\\b`,
  label: "phone number",
  score: 0.9,
};

// Czech license plates (SPZ/RZ).
// New format: 3SJ 0753 — digit, two letters, space?,
// four digits. Old format: 1A2 3456 — digit, letter,
// digit, space?, four digits.

// Czech/Slovak postal code: "110 00", "120 00".
// The distinctive XXX XX format with mandatory
// space is specific enough to avoid most false
// positives.
const CZ_POSTAL: RegexDef = {
  pattern: `\\b\\d{3}[^\\S\\n]\\d{2}\\b`,
  label: "address",
  score: 0.7,
};

// URL: scheme + host + optional port + path + query +
// fragment. Trailing prose punctuation excluded but
// ? = & # kept for query strings.
// Allow missing // after http:/https: — common OCR
// artifact ("http:example.cz" instead of
// "http://example.cz"). Lookahead ensures bare scheme
// is not matched in isolation (e.g., "http:" at EOL).
const URL: RegexDef = {
  pattern:
    `(?:https?://|https?:(?=[^\\s])|www\\.)` +
    `[\\w\\-]+(?:\\.[\\w\\-]+)+` +
    `(?::\\d+)?` +
    `(?:[/?#][^\\s)\\]>]*[^\\s.,;:!?)\\]>])?`,
  label: "url",
  score: 1,
};

// Bare domain: no protocol/www prefix, ends with a
// known TLD. Catches "fondkinematografie.cz" etc.
// Uses [a-zA-Z0-9] (no underscores — invalid in
// hostnames). Short ambiguous TLDs (de, at, no, se,
// fi, dk, be, it, uk) require at least one subdomain
// dot to reduce false positives in European legal
// text; unambiguous TLDs allow bare second-level
// domains (e.g., "fondkinematografie.cz").
const LONG_TLDS =
  "com|org|net|eu|cz|sk|pl|hu|ro|fr|es" +
  "|co\\.uk|nl|ch|info|io|dev";
const SHORT_TLDS = "de|at|be|se|fi|dk|no|it|uk";
// RFC 1123: labels cannot start or end with hyphen.
const HOST_LABEL =
  `[a-zA-Z0-9](?:[a-zA-Z0-9\\-]*[a-zA-Z0-9])?`;
const BARE_HOST =
  `\\b[a-zA-Z0-9][a-zA-Z0-9\\-]+[a-zA-Z0-9]`;
const PATH_SUFFIX =
  `(?:[/?#][^\\s)\\]>]*[^\\s.,;:!?)\\]>])?`;
const BARE_DOMAIN: RegexDef = {
  pattern:
    // Unambiguous TLDs: bare SLDs ok (one dot)
    `${BARE_HOST}(?:\\.${HOST_LABEL})*` +
    `\\.(?:${LONG_TLDS})\\b${PATH_SUFFIX}` +
    `|` +
    // Short/ambiguous TLDs: require subdomain (two+ dots)
    `${BARE_HOST}(?:\\.${HOST_LABEL})+` +
    `\\.(?:${SHORT_TLDS})\\b${PATH_SUFFIX}`,
  label: "url",
  score: 0.9,
};


// Full RFC 5952 IPv6. :: compressed form replaces
// 1+ zero groups. Right side: 1-7 hex groups.
const IPV6_ADDRESS: RegexDef = {
  pattern:
    `\\b(?:[0-9a-fA-F]{1,4}:){7}` +
    `[0-9a-fA-F]{1,4}\\b` +
    `|\\b(?:[0-9a-fA-F]{1,4}:){1,7}:\\b` +
    `|::(?:[0-9a-fA-F]{1,4}:){0,6}` +
    `[0-9a-fA-F]{1,4}`,
  label: "ip address",
  score: 1,
};

// MAC: colon-only OR hyphen-only (no mixed).
const MAC_ADDRESS: RegexDef = {
  pattern:
    `\\b(?:[0-9a-fA-F]{2}:){5}` +
    `[0-9a-fA-F]{2}\\b` +
    `|\\b(?:[0-9a-fA-F]{2}-){5}` +
    `[0-9a-fA-F]{2}\\b`,
  label: "mac address",
  score: 1,
};

// SWIFT/BIC moved to trigger-based detection
// (triggers.global.json) for better composability.

// ── Collected definitions ────────────────────────────

/**
 * All static PII regex definitions. Scanned in a
 * single pass by @stll/regex-set (Rust DFA).
 *
 * Hand-written patterns (0-17) followed by
 * stdnum-derived patterns (18+). Each stdnum entry
 * has a post-match validator for confirmation.
 *
 * Monetary amount patterns are built dynamically from
 * currencies.json via `getCurrencyPatterns()`.
 *
 * Date patterns using written month names are built
 * dynamically from date-months.json via
 * `getDatePatterns()`.
 */
const ALL_REGEX_DEFS: readonly RegexDef[] = [
  TITLED_PERSON,
  HONORIFIC_PERSON,
  IBAN,
  EMAIL,
  INTL_PHONE,
  CZ_PHONE,
  TEL_PREFIX_PHONE,
  CREDIT_CARD,
  CZ_BIRTH_NUMBER,
  DATE_NUMERIC,
  DATE_CZ_SPACED,
  IP_ADDRESS,
  CZ_BANK_ACCOUNT,
  HU_LANDLINE,
  CZ_POSTAL,
  URL,
  IPV6_ADDRESS,
  MAC_ADDRESS,
  BARE_DOMAIN,
  ...STDNUM_ENTRIES,
];

/** Flat pattern array for text-search. */
export const REGEX_PATTERNS: readonly string[] =
  ALL_REGEX_DEFS.map((d) => d.pattern);

/** Parallel metadata. Index = pattern index. */
export const REGEX_META: readonly RegexMeta[] =
  ALL_REGEX_DEFS.map((d): RegexMeta => {
    const meta: RegexMeta = {
      label: d.label,
      score: d.score,
    };
    if (d.validator) {
      meta.validator = d.validator;
    }
    return meta;
  });

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
  // Optional time suffix: "19:45:50" or "19:45"
  const TIME = `(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)`;
  return [
  // a. DD[.] Month[.] YYYY [HH:MM[:SS]]
  `(?i)\\b\\d{1,2}\\.?\\s+(?:${alt})\\.?\\s+\\d{4}${TIME}?\\b`,
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

// ── Dynamic currency patterns ──────────────────────

/**
 * JSON shape from currencies.json: ISO 4217 codes,
 * common currency symbols, and local currency names.
 */
type CurrenciesData = {
  codes: string[];
  symbols: string[];
  localNames?: string[];
};

/**
 * Build symbol character class, code alternation,
 * and local-name alternation from currencies.json,
 * then return two monetary amount patterns: leading
 * symbol and trailing code/name.
 *
 * The number sub-pattern accepts both grouped
 * thousands (1,000) and plain integers (100000)
 * via `\d{1,9}` to catch unformatted amounts.
 */
const buildCurrencyPatterns = (
  data: CurrenciesData,
): string[] => {
  const symbols = data.symbols
    .map(escapeCharClass)
    .join("");

  // Build trailing alternation: ISO codes (case-
  // sensitive, always uppercase) + local names.
  // Local names that contain only ASCII letters
  // are wrapped in (?i:...) for case-insensitive
  // matching; abbreviations with non-ASCII or
  // punctuation (Kč, zł, Fr.) stay case-sensitive.
  // Sorted longest-first to avoid partial matches.
  const isAsciiAlpha = /^[a-zA-Z\s]+$/;

  type TrailingPart = { len: number; alt: string };
  const parts: TrailingPart[] = data.codes.map(
    (code) => ({
      len: code.length,
      alt: escapeRegex(code),
    }),
  );

  // Minimum length for case-insensitive wrapping.
  // Short abbreviations like "Ft" (2 chars) stay
  // case-sensitive to avoid collisions (Ft vs ft/feet).
  const MIN_CI_LENGTH = 3;

  if (data.localNames) {
    for (const name of data.localNames) {
      const escaped = escapeRegex(name);
      const wrapCI =
        isAsciiAlpha.test(name) &&
        name.length >= MIN_CI_LENGTH;
      if (wrapCI) {
        parts.push({
          len: name.length,
          alt: `(?i:${escaped})`,
        });
      } else {
        parts.push({ len: name.length, alt: escaped });
      }
    }
  }

  // Also include currency symbols as trailing
  // alternatives (e.g., "126 €", "8 190 £").
  // These are common in European notation.
  if (symbols) {
    for (const ch of data.symbols) {
      parts.push({
        len: ch.length,
        alt: escapeRegex(ch),
      });
    }
  }

  const trailingAlt = parts
    .toSorted((a, b) => b.len - a.len)
    .map((p) => p.alt)
    .join("|");

  if (!symbols && !trailingAlt) return [];

  // Number sub-pattern: grouped thousands OR plain
  // integer up to 9 digits (covers unformatted
  // amounts like "100000 CZK").
  const NUM =
    `(?:\\d{1,3}(?:[,.'[^\\S\\n\\t]]\\d{3})+` +
    `|\\d{1,9})`;

  const patterns: string[] = [];

  // Leading symbol: $100, €1,000.50, € 100000
  if (symbols) {
    patterns.push(
      `(?:[${symbols}])` +
        `[^\\S\\n\\t]?` +
        `${NUM}` +
        `(?:[.,][^\\S\\n\\t]?(?:\\d{1,2}${DASH}?|${DASH}{1,2})?)?\\b`,
    );
  }

  // Leading multi-char code: "Kč 10,—", "Fr. 500"
  // Uses the trailing alternation in reverse position.
  if (trailingAlt) {
    patterns.push(
      `\\b(?:${trailingAlt})` +
        `[^\\S\\n\\t]{0,2}` +
        `${NUM}` +
        `(?:[.,][^\\S\\n\\t]?(?:\\d{1,2}${DASH}?|${DASH}{1,2})?)?\\b`,
    );
  }

  // Trailing code/name: 100 USD, 1,000.50 CZK,
  // 100000 Kč, 500 korun, 100 Fr.
  // Use (?:\b|(?=\s|[.,;!?)]|$)) instead of bare
  // \b so entries ending in non-word characters
  // (e.g. "Fr.") still match at word boundaries.
  if (trailingAlt) {
    patterns.push(
      `\\b${NUM}` +
        `(?:[.,][^\\S\\n\\t]?(?:\\d{1,2}${DASH}?|${DASH}{1,2})?)?[^\\S\\n\\t]{0,4}` +
        `(?:${trailingAlt})` +
        `(?:\\b|(?=\\s|[.,;!?)]|$))`,
    );
  }

  return patterns;
};

/** Cached promise for currency patterns. Loaded once. */
let currencyPatternPromise:
  | Promise<string[]>
  | null = null;

const loadCurrencyPatterns =
  async (): Promise<string[]> => {
    const mod = await import(
      "@stll/anonymize-data/config/currencies.json"
    );
    const data: CurrenciesData = mod.default ?? mod;
    return buildCurrencyPatterns(data);
  };

/**
 * Get dynamically built monetary amount patterns from
 * currencies.json. Returns a cached promise; the JSON
 * is loaded only once.
 */
export const getCurrencyPatterns =
  (): Promise<string[]> => {
    if (!currencyPatternPromise) {
      currencyPatternPromise =
        loadCurrencyPatterns().catch((err) => {
          currencyPatternPromise = null;
          throw err;
        });
    }
    return currencyPatternPromise;
  };

/** Currency pattern metadata (score 0.9). */
export const CURRENCY_PATTERN_META: Readonly<RegexMeta> =
  Object.freeze({
    label: "monetary amount",
    score: 0.9,
  });

// ── Public API ──────────────────────────────────────

/**
 * Process regex matches from the unified search.
 * Receives all matches; filters to the regex slice
 * via sliceStart/sliceEnd. Local index into META is
 * match.pattern - sliceStart.
 *
 * For stdnum-derived patterns (those with a validator
 * in META), the matched text is passed through the
 * validator's validate() method. If validation fails,
 * the match is discarded as a false positive.
 */
export const processRegexMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  meta_: readonly RegexMeta[],
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const localIdx = idx - sliceStart;
    const meta = meta_[localIdx];
    if (!meta) {
      continue;
    }
    if (
      meta.label === "phone number" &&
      match.text.length < MIN_PHONE_LENGTH
    ) {
      continue;
    }

    // Post-match validation: if the pattern came from
    // a stdnum validator, compact (strip separators)
    // then validate. The candidate regex may capture
    // spaced/dashed variants that validate() rejects
    // without compaction.
    if (meta.validator) {
      const compacted = meta.validator.compact(
        match.text,
      );
      const result = meta.validator.validate(compacted);
      if (!result.valid) {
        continue;
      }
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

// ── Dynamic signing clause patterns ────────────────

type SigningClauseConfig = {
  patterns: Array<{
    lang: string;
    prefix: string;
    suffix: string;
    prepositions: string[];
  }>;
};

/**
 * Build signing clause place-name patterns from
 * signing-clauses.json. Each pattern captures the
 * city/place name from contract signing locations.
 *
 * The place name sub-pattern:
 *   \p{Lu}\p{Ll}+ (capitalized word)
 *   optionally followed by preposition + capitalized
 *   word (for "nad Nisou", "am Main", etc.)
 *   optionally followed by more capitalized words
 *   (for "Hradec Králové", "New York", etc.)
 */
const buildSigningClausePatterns = (
  data: SigningClauseConfig,
): string[] => {
  const patterns: string[] = [];

  for (const entry of data.patterns) {
    const prepAlt =
      entry.prepositions.length > 0
        ? entry.prepositions.join("|")
        : null;

    // Place name: Uppercase word, optionally with
    // preposition + uppercase, optionally more caps
    const place = prepAlt
      ? `(\\p{Lu}\\p{Ll}+` +
        `(?:\\s+(?:${prepAlt})\\s+\\p{Lu}\\p{Ll}+)*` +
        `(?:\\s+\\p{Lu}\\p{Ll}+)*)`
      : `(\\p{Lu}\\p{Ll}+(?:[- ]\\p{Lu}\\p{Ll}+)*)`;

    const full =
      `(?:^|\\n|[^\\S\\n])` +
      entry.prefix +
      place +
      (entry.suffix ? `(?:${entry.suffix})` : "");

    patterns.push(full);
  }

  return patterns;
};

export const SIGNING_CLAUSE_META: Readonly<RegexMeta> =
  { label: "address", score: 0.9 };

let signingPatternPromise: Promise<string[]> | null =
  null;

const loadSigningPatterns =
  async (): Promise<string[]> => {
    const mod = await import(
      "@stll/anonymize-data/config/signing-clauses.json"
    );
    const data: SigningClauseConfig =
      mod.default ?? mod;
    return buildSigningClausePatterns(data);
  };

export const getSigningClausePatterns =
  (): Promise<string[]> => {
    if (!signingPatternPromise) {
      signingPatternPromise =
        loadSigningPatterns().catch((err) => {
          signingPatternPromise = null;
          throw err;
        });
    }
    return signingPatternPromise;
  };
