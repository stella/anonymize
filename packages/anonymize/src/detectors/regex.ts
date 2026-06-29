import type { Match, PatternEntry } from "@stll/text-search";
import type { Validator } from "@stll/stdnum";
import {
  at,
  au,
  be,
  bg,
  br,
  ch,
  cn,
  crypto,
  cz,
  cy,
  de,
  dk,
  ee,
  es,
  fi,
  fr,
  gb,
  gr,
  hr,
  hu,
  ie,
  it,
  lt,
  lu,
  lv,
  mt,
  nl,
  no,
  pl,
  pt,
  ro,
  se,
  si,
  sk,
  us,
} from "@stll/stdnum";
import { toRegex } from "@stll/stdnum/patterns";

import {
  HONORIFIC_ABBREVIATION,
  HONORIFIC_BOUNDARY,
  HONORIFICS,
  POST_NOMINALS,
  TITLE_PREFIXES,
} from "../config/titles";
import amountWordsConfig from "../data/amount-words.json";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { DASH, DASH_INNER } from "../util/char-groups";

const MIN_PHONE_LENGTH = 7;
const MIN_MONTH_NAME_LENGTH = 3;
const CONTEXT_REGEX_PREFILTER_WINDOW_BYTES = 160;
const US_STATE_CODE =
  "(?:(?i:A[KLZR]|C[AOT]|D[CE]|FL|GA|HI|I[ADL]|K[SY]|LA|M[ADEHINOPST]|" +
  "N[CDEHJMVY]|O[HK]|PA|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])|I[Nn]|iN|O[Rr]|oR)";

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

const escapeRegexPhrase = (s: string): string =>
  escapeRegex(s.trim()).replace(/\s+/g, "[^\\S\\n\\t]+");

/** Escape for use inside a regex character class. */
const escapeCharClass = (s: string): string => s.replace(/[\]\\^-]/g, "\\$&");

const utf8ByteLength = (text: string): number => {
  let length = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      length += 1;
    } else if (codePoint <= 0x7ff) {
      length += 2;
    } else if (codePoint <= 0xffff) {
      length += 3;
    } else {
      length += 4;
    }
  }
  return length;
};

const toSortedAlternation = (values: readonly string[]): string =>
  [
    ...new Set(
      values.map(escapeRegexPhrase).filter((value) => value.length > 0),
    ),
  ]
    .toSorted((a, b) => b.length - a.length)
    .join("|");

const TITLE_PREFIX = TITLE_PREFIXES.toSorted((a, b) => b.length - a.length)
  .map(escapeTitle)
  .join("|");

const POST_NOMINAL = POST_NOMINALS.toSorted((a, b) => b.length - a.length)
  .map(escapeTitle)
  .join("|");

// Unicode property classes keep the name-word pattern
// language-agnostic: any uppercase letter followed by
// lowercase letters works for cs/de/fr/it/es/sk and any
// future language with cased scripts. The Rust regex
// engine downstream (@stll/text-search) supports \p{Lu}
// and \p{Ll} natively.
const NAME_WORD = `\\p{Lu}\\p{Ll}+`;

const PARTICLE =
  `(?:van der|van den|de la|della|` +
  `von|van|dos|ibn|ben|bin|del|zum|zur|ten|ter|` +
  `da|de|di|al|el|le|la|zu|af|av)`;

// Non-newline whitespace. Tabs are admitted because
// DOCX exports routinely place a TAB between an
// academic title and the following name (table-cell
// layouts like "Ing.\tStanislav Braňka"); newlines
// are not, so spans cannot bleed across paragraphs.
const SP = "[^\\S\\n]";

/** Honorific alternation built from titles.ts config. Sorted
 * longest-first so e.g. "Sig.ra" wins over "Sig.". */
const buildHonorificAlt = (entries: readonly string[]): string =>
  [...entries]
    .toSorted((a, b) => b.length - a.length)
    .map((h) => {
      const escaped = escapeRegex(h);
      return HONORIFIC_BOUNDARY.has(h) ? `\\b${escaped}` : escaped;
    })
    .join("|");

// Abbreviation honorifics ("Mr", "Sr.") may be followed by an
// abbreviation dot; full-word honorifics ("President", "Lord")
// may not, so a sentence-ending period after them is not consumed
// and the person span stops at the sentence boundary.
const HONORIFIC_ABBREV_ALT = buildHonorificAlt(
  HONORIFICS.filter((h) => HONORIFIC_ABBREVIATION.has(h)),
);
const HONORIFIC_FULLWORD_ALT = buildHonorificAlt(
  HONORIFICS.filter((h) => !HONORIFIC_ABBREVIATION.has(h)),
);

// ── Pattern definitions ─────────────────────────────

export type RegexMeta = {
  label: string;
  score: number;
  sourceDetail?: Entity["sourceDetail"];
  minByteLength?: number;
  /** Post-match stdnum validator for confirmation. */
  validator?: Validator;
  validatorId?: string;
  /** Extract the identifier portion when context is part of the regex span. */
  validatorInput?: (text: string) => string;
  validatorInputKind?: "digits-only" | "crypto-wallet-candidate";
};

type RegexDef = {
  pattern: string;
  label: string;
  score: number;
  minByteLength?: number;
  lazy?: true;
  prefilterAny?: readonly string[];
  prefilterCaseInsensitive?: boolean;
  prefilterRegex?: RegExp;
  prefilterWindowBytes?: number;
  validator?: Validator;
  validatorId?: string;
  validatorInput?: (text: string) => string;
  validatorInputKind?: "digits-only" | "crypto-wallet-candidate";
};

type RegexPatternEntry = {
  pattern: string;
  literal?: false;
  lazy?: true;
  prefilterAny?: readonly string[];
  prefilterCaseInsensitive?: boolean;
  prefilterRegex?: RegExp;
  prefilterWindowBytes?: number;
};

type AmountWordsConfig = {
  patterns?: Array<{
    lang: string;
    keywords: string[];
  }>;
  percentages?: Array<{
    lang: string;
    keywords: string[];
    ones: string[];
    teens: string[];
    tens: string[];
    standalone?: string[];
    allowSpaceCompoundSeparator?: boolean;
  }>;
  magnitudeSuffixes?: Array<{
    lang: string;
    words?: string[];
    abbreviationsCaseInsensitive?: string[];
    abbreviationsCaseSensitive?: string[];
  }>;
  shareQuantityTerms?: Array<{
    lang: string;
    modifiers?: string[];
    nouns: string[];
  }>;
};

const AMOUNT_WORDS = amountWordsConfig as AmountWordsConfig;

const DIGITS_ONLY_VALIDATOR_INPUT = (text: string): string =>
  text.replace(/\D/g, "");

const VALIDATOR_IDS = new Map<Validator, string>([
  [at.businessid, "at.businessid"],
  [at.tin, "at.tin"],
  [at.uid, "at.uid"],
  [au.abn, "au.abn"],
  [au.acn, "au.acn"],
  [be.nn, "be.nn"],
  [be.vat, "be.vat"],
  [bg.vat, "bg.vat"],
  [br.cnpj, "br.cnpj"],
  [br.cpf, "br.cpf"],
  [ch.uid, "ch.uid"],
  [cn.ric, "cn.ric"],
  [crypto.wallet, "crypto.wallet"],
  [cy.vat, "cy.vat"],
  [cz.dic, "cz.dic"],
  [cz.rc, "cz.rc"],
  [de.idnr, "de.idnr"],
  [de.stnr, "de.stnr"],
  [de.svnr, "de.svnr"],
  [de.vat, "de.vat"],
  [dk.cpr, "dk.cpr"],
  [dk.vat, "dk.vat"],
  [ee.ik, "ee.ik"],
  [ee.vat, "ee.vat"],
  [es.cif, "es.cif"],
  [es.dni, "es.dni"],
  [es.nie, "es.nie"],
  [es.nss, "es.nss"],
  [es.vat, "es.vat"],
  [fi.hetu, "fi.hetu"],
  [fi.vat, "fi.vat"],
  [fi.ytunnus, "fi.ytunnus"],
  [fr.nir, "fr.nir"],
  [fr.siren, "fr.siren"],
  [fr.siret, "fr.siret"],
  [fr.tva, "fr.tva"],
  [gb.nhs, "gb.nhs"],
  [gb.nino, "gb.nino"],
  [gb.vat, "gb.vat"],
  [gr.vat, "gr.vat"],
  [hr.vat, "hr.vat"],
  [hu.vat, "hu.vat"],
  [ie.pps, "ie.pps"],
  [ie.vat, "ie.vat"],
  [it.codiceFiscale, "it.codiceFiscale"],
  [it.iva, "it.iva"],
  [lt.asmens, "lt.asmens"],
  [lt.vat, "lt.vat"],
  [lu.vat, "lu.vat"],
  [lv.vat, "lv.vat"],
  [mt.vat, "mt.vat"],
  [nl.vat, "nl.vat"],
  [no.mva, "no.mva"],
  [no.orgnr, "no.orgnr"],
  [pl.nip, "pl.nip"],
  [pl.pesel, "pl.pesel"],
  [pt.cc, "pt.cc"],
  [pt.vat, "pt.vat"],
  [ro.cnp, "ro.cnp"],
  [ro.vat, "ro.vat"],
  [se.personnummer, "se.personnummer"],
  [si.vat, "si.vat"],
  [sk.dic, "sk.dic"],
  [us.ein, "us.ein"],
]);

export const NATIVE_REGEX_VALIDATOR_IDS: ReadonlySet<string> = new Set([
  "au.abn",
  "au.acn",
  "at.businessid",
  "at.tin",
  "at.uid",
  "be.nn",
  "be.vat",
  "bg.vat",
  "br.cnpj",
  "br.cpf",
  "ch.uid",
  "cn.ric",
  "crypto.wallet",
  "cy.vat",
  "cz.dic",
  "cz.rc",
  "de.idnr",
  "de.stnr",
  "de.svnr",
  "de.vat",
  "dk.cpr",
  "dk.vat",
  "ee.ik",
  "ee.vat",
  "es.cif",
  "es.dni",
  "es.nie",
  "es.nss",
  "es.vat",
  "fi.hetu",
  "fi.vat",
  "fi.ytunnus",
  "fr.nir",
  "fr.siren",
  "fr.siret",
  "fr.tva",
  "gb.nhs",
  "gb.nino",
  "gb.vat",
  "gr.vat",
  "hr.vat",
  "hu.vat",
  "ie.pps",
  "ie.vat",
  "it.codiceFiscale",
  "it.iva",
  "lt.asmens",
  "lt.vat",
  "lu.vat",
  "lv.vat",
  "mt.vat",
  "nl.vat",
  "no.mva",
  "no.orgnr",
  "pl.nip",
  "pl.pesel",
  "pt.cc",
  "pt.vat",
  "ro.cnp",
  "ro.vat",
  "se.personnummer",
  "si.vat",
  "sk.dic",
  "us.ein",
  "us.rtn",
]);

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
  toEntry(it.codiceFiscale, "national identification number", 0.95),
  // es.dni / es.nie omitted: stdnum patterns are over-fit to
  // the spec letter (`Q` / `X`) and miss real-world prefixes;
  // covered by the format-level ES_DNI / ES_NIE regex below.
  toEntry(se.personnummer, "national identification number", 0.9),
  toEntry(ro.cnp, "national identification number", 0.95),
  toEntry(fr.nir, "social security number", 0.9),

  // ── CZ validators ────────────────────────────────
  toEntry(cz.dic, "tax identification number", 0.95),
  // cz.ico and cz.rc omitted: cz.ico is \d{8} (too
  // generic), cz.rc is \d{6}/\d{3,4} (handled by
  // pattern 7: czech birth number)

  // ── DE validators ────────────────────────────────
  toEntry(de.vat, "tax identification number", 0.95),
  toEntry(de.idnr, "tax identification number", 0.9),
  toEntry(de.stnr, "tax identification number", 0.9),
  toEntry(de.svnr, "social security number", 0.9),

  // ── PL validators ────────────────────────────────
  toEntry(pl.nip, "tax identification number", 0.95),
  toEntry(pl.pesel, "national identification number", 0.9),
  // pl.regon omitted: \d{9,14} too generic

  // ── GB validators ────────────────────────────────
  toEntry(gb.vat, "tax identification number", 0.95),
  toEntry(gb.nino, "social security number", 0.95),
  // gb.utr omitted: \d{10} too generic

  // ── AT validators ────────────────────────────────
  toEntry(at.uid, "tax identification number", 0.95),
  toEntry(at.tin, "tax identification number", 0.9),
  toEntry(at.businessid, "registration number", 0.95),

  // ── CH validators ────────────────────────────────
  // Swiss UID: CHE + 9 digits with checksum. It is a
  // company identifier; VAT-specific usage reuses the
  // same base number with tax suffixes, so the bare
  // shape is labelled as registration number.
  toEntry(ch.uid, "registration number", 0.95),

  // ── AU validators ────────────────────────────────
  toEntry(au.abn, "tax identification number", 0.9),
  toEntry(au.acn, "registration number", 0.9),

  // ── BE validators ────────────────────────────────
  toEntry(be.vat, "tax identification number", 0.95),
  toEntry(be.nn, "national identification number", 0.9),

  // ── NL validators ────────────────────────────────
  toEntry(nl.vat, "tax identification number", 0.95),
  // nl.bsn omitted: \d{9} too generic

  // ── NO validators ────────────────────────────────
  toEntry(no.orgnr, "registration number", 0.9),
  toEntry(no.mva, "tax identification number", 0.95),

  // ── DK validators ────────────────────────────────
  toEntry(dk.vat, "tax identification number", 0.95),
  toEntry(dk.cpr, "national identification number", 0.9),

  // ── FI validators ────────────────────────────────
  toEntry(fi.vat, "tax identification number", 0.95),
  toEntry(fi.hetu, "national identification number", 0.95),
  toEntry(fi.ytunnus, "registration number", 0.9),

  // ── BG validators ────────────────────────────────
  toEntry(bg.vat, "tax identification number", 0.95),

  // ── SK validators ────────────────────────────────
  toEntry(sk.dic, "tax identification number", 0.95),
  // sk.ico: \d{8} too generic; sk.rc overlaps with
  // czech birth number pattern

  // ── ES additional validators ─────────────────────
  // es.cif omitted: stdnum's candidatePattern is over-fit
  // to the spec letter and misses real-world prefixes;
  // covered by the format-level ES_CIF regex below.
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
  toEntry(ie.pps, "national identification number", 0.9),

  // ── PT validators ────────────────────────────────
  toEntry(pt.vat, "tax identification number", 0.95),
  toEntry(pt.cc, "national identification number", 0.9),

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
  toEntry(lt.asmens, "national identification number", 0.9),

  // ── LV validators ────────────────────────────────
  toEntry(lv.vat, "tax identification number", 0.95),

  // ── EE validators ────────────────────────────────
  toEntry(ee.vat, "tax identification number", 0.95),
  toEntry(ee.ik, "national identification number", 0.9),

  // ── CY validators ────────────────────────────────
  toEntry(cy.vat, "tax identification number", 0.95),

  // ── MT validators ────────────────────────────────
  toEntry(mt.vat, "tax identification number", 0.95),

  // ── LU validators ────────────────────────────────
  toEntry(lu.vat, "tax identification number", 0.95),

  // ── US validators ────────────────────────────────
  toEntry(us.ein, "tax identification number", 0.9),

  // ── BR validators ────────────────────────────────
  // CPF (personal tax ID, 11 digits, checksum). Higher
  // score than the generic phone patterns so the
  // overlap resolver prefers the tax-ID label.
  toEntry(br.cpf, "tax identification number", 0.95),
  toEntry(br.cnpj, "tax identification number", 0.95),

  // ── CN validators ────────────────────────────────
  // RIC (Resident Identity Card, 18-digit modern form:
  // region + YYYYMMDD + sequence + MOD 11-2 check digit,
  // last position may be `X`). The pattern is tightened
  // to a digit-only `\d{17}[\dX]` shape so it can't
  // match alphanumeric blobs that share the length
  // bucket; the validator then enforces the embedded
  // birth date and the checksum.
  //
  // The legacy 15-digit form is NOT covered: its bare
  // `\d{15}` shape is shadowed by the `fr.nir` pattern
  // (also 15 digits) in the unified text-search engine,
  // which returns only one match per position and picks
  // the earlier-registered pattern. The modern 18-digit
  // form has dominated CN issuance since 1999, so the
  // gap is theoretical for current corpora.
  // Lookbehind/lookahead use an ASCII identifier class rather than
  // `\w`: the text-search regex backend treats `\w` as Unicode word
  // chars, which would have CJK label prefixes (`身份证号120…`) satisfy
  // the negative boundary and block matches in native-language
  // contexts. Restricting the boundary to ASCII identifier chars
  // still rejects the cases the boundary exists for — order/account
  // numbers (`Order 1201…`, `ID-1201…`).
  //
  // The check-digit class accepts both `X` and `x`: real-world IDs
  // are commonly written with the lowercase variant, and the stdnum
  // validator's compact step normalises the case before checksum.
  {
    validator: cn.ric,
    label: "national identification number",
    score: 0.95,
    pattern: "(?<![A-Za-z0-9_])\\d{17}[\\dXx](?![A-Za-z0-9_])",
  },
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
    `(?:(?:${HONORIFIC_ABBREV_ALT})\\.?|(?:${HONORIFIC_FULLWORD_ALT}))` +
    `${SP}+${NAME_WORD}` +
    `(?:(?:${SP}|-){1,2}(?:${PARTICLE}${SP}+)?` +
    `${NAME_WORD}){0,3}` +
    `(?:${SP}+(?:QC|KC|SC|LJ|AG))?`,
  label: "person",
  score: 0.95,
};

// Bare post-nominal anchor: a multi-word capitalised
// name followed by a UK senior-barrister rank
// (KC/QC). Picks up "John Smith KC" /
// "Jane Doe-Robinson QC" without requiring a title
// prefix or honorific. Other post-nominals (Ph.D.,
// MBA, …) are intentionally NOT in this alternation
// — they over-fire on non-name patterns. KC/QC are
// safe because the two-letter rank only ever follows
// a real person name in UK prose.
const POSTNOMINAL_PERSON: RegexDef = {
  pattern:
    `${NAME_WORD}` +
    `(?:(?:${SP}|-){1,2}(?:${PARTICLE}${SP}+)?` +
    `${NAME_WORD}){1,3}` +
    // Either `Name KC` or `Name, KC` — UK convention
    // varies between Bar Council style (no comma) and
    // older legal-citation style (with comma).
    `,?${SP}+(?:KC|QC)\\b`,
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
  pattern: `\\b[\\w.+\\-]+@[\\w\\-]+(?:\\.[\\w\\-]+)+\\b`,
  label: "email address",
  score: 1,
  lazy: true,
  prefilterAny: ["@"],
  prefilterCaseInsensitive: false,
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
  minByteLength: MIN_PHONE_LENGTH,
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
  minByteLength: MIN_PHONE_LENGTH,
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
  minByteLength: MIN_PHONE_LENGTH,
  lazy: true,
  prefilterAny: ["tel", "telefon"],
  prefilterCaseInsensitive: true,
};

/**
 * US phone numbers in the (NNN) NNN-NNNN form. Dominant
 * shape in US notice blocks ("(212) 735-3000"); not
 * covered by INTL_PHONE (which requires a leading `+`)
 * or TEL_PREFIX_PHONE (which requires a `tel.:` label).
 *
 * The parenthesised area code is the constraint that
 * keeps this from matching random digit clusters —
 * `(212) 555-1212` looks like nothing else in a contract.
 * Score below INTL_PHONE (1) and TEL_PREFIX_PHONE (0.95)
 * so labelled / fully-qualified forms still win the
 * overlap resolver when both fire on the same span.
 */
const US_PAREN_PHONE: RegexDef = {
  pattern:
    `\\(\\d{3}\\)(?:[^\\S\\n]|[.\\-])?\\d{3}` + `(?:[^\\S\\n]|[.\\-])\\d{4}\\b`,
  label: "phone number",
  score: 0.9,
  minByteLength: MIN_PHONE_LENGTH,
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
  label: "birth number",
  score: 1,
  validator: cz.rc,
};

// Czech commercial-register reference. Every Czech
// legal entity in the public registry is uniquely
// identified by a registry section letter ("oddíl X")
// plus an insert number ("vložka NNN"). The full phrase
// uniquely identifies the company, so we emit it as a
// single registration-number entity rather than only
// capturing the trailing digits.
//
// Tolerances:
//   - case-insensitive "oddíl" / "vložka";
//   - optional whitespace around comma and after each
//     keyword (DOCX exports add NBSPs and double
//     spaces);
//   - section letter is a single A-Z; insert number is
//     a 1-6 digit integer.
const CZ_COMMERCIAL_REGISTER: RegexDef = {
  pattern:
    `\\b[Oo][Dd][Dd][Íí][Ll][^\\S\\n]+[A-Za-z]` +
    `[^\\S\\n]*,[^\\S\\n]*` +
    `[Vv][Ll][Oo][Žž][Kk][Aa][^\\S\\n]+\\d{1,6}\\b`,
  label: "registration number",
  score: 0.95,
  lazy: true,
  prefilterAny: ["oddíl", "vložka"],
  prefilterCaseInsensitive: true,
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
  pattern: `\\b\\d{1,2}\\.[^\\S\\n]+\\d{1,2}\\.[^\\S\\n]+\\d{4}\\b`,
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
  pattern: `\\b(?:\\d{1,6}-)?\\d{6,10}/\\d{4}(?!\\d)`,
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
  minByteLength: MIN_PHONE_LENGTH,
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

// Spanish postal code (CP): 5 digits preceded by a
// CP marker ("C.P.", "CP", "código postal"). The
// marker is required to avoid matching arbitrary
// 5-digit numbers (document IDs, ISBNs, etc.).
// The pattern uses `includeTrigger`-style prefixing:
// the marker is part of the match span (length
// trimmed downstream if needed).
const ES_POSTAL: RegexDef = {
  pattern:
    `\\b(?:C\\.?P\\.?|[Cc][óo]digo[^\\S\\n]+postal)` +
    `[^\\S\\n]{0,3}:?[^\\S\\n]{0,3}\\d{5}\\b`,
  label: "address",
  score: 0.7,
  lazy: true,
  prefilterAny: ["C.P", "CP", "código postal", "codigo postal"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

// Spanish DNI: 8 digits + 1 letter. Letter is a
// checksum; post-match validator confirms.
// Pattern derived from stdnum (es.dni) candidatePattern,
// constrained for DFA compatibility.
const ES_DNI: RegexDef = {
  pattern: `\\b\\d{8}-?[A-Za-z]\\b`,
  label: "national identification number",
  score: 0.9,
  validator: es.dni,
};

// Spanish NIE: X/Y/Z + 7 digits + check letter.
// Pattern derived from stdnum (es.nie) candidatePattern.
const ES_NIE: RegexDef = {
  pattern: `\\b[XYZxyz]-?\\d{7}-?[A-Za-z]\\b`,
  label: "national identification number",
  score: 0.95,
  validator: es.nie,
};

// Spanish CIF: org-type letter (A-H, J, N, P-S, U-W),
// then 7 digits, then a check character (digit or A-J).
// Pattern derived from stdnum (es.cif) candidatePattern.
const ES_CIF: RegexDef = {
  pattern: `\\b[A-HJNP-SUVWa-hjnp-suvw]-?\\d{7}-?[0-9A-Ja-j]\\b`,
  label: "registration number",
  score: 0.95,
  validator: es.cif,
};

const NHS_NUMBER_CONTEXT: RegexDef = {
  pattern:
    "\\b(?:(?i:NHS)(?:[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))?|" +
    "(?i:National)[^\\S\\n]+(?i:Health)[^\\S\\n]+(?i:Service)" +
    "[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))" +
    "[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}\\d{3}[^\\S\\n]?\\d{3}[^\\S\\n]?\\d{4}\\b",
  label: "national identification number",
  score: 0.95,
  validator: gb.nhs,
  validatorInput: DIGITS_ONLY_VALIDATOR_INPUT,
  validatorInputKind: "digits-only",
  lazy: true,
  prefilterAny: ["NHS", "National Health Service"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const PASSPORT_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?:(?i:U\\.?S\\.?)|(?i:USA)|(?i:United)[^\\S\\n]+(?i:States)|` +
    `(?i:UK)|(?i:U\\.?K\\.?)|(?i:GBR)|(?i:British)|(?i:EU)|` +
    `(?i:European)|(?i:France)|(?i:French))[^\\S\\n]{1,4})?` +
    `(?i:passports?)` +
    `(?:[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))?` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `(?:[A-Za-z]{1,2}\\d{6,8}|\\d{2}[A-Za-z]{2}\\d{5}|\\d{7,9})\\b`,
  label: "passport number",
  score: 0.96,
  lazy: true,
  prefilterAny: ["passport"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const FR_CNI_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?i:CNI)|(?i:carte)[^\\S\\n]+(?i:nationale)[^\\S\\n]+(?i:d)[’'](?i:identit[ée])|` +
    `(?i:French)[^\\S\\n]+(?i:national)[^\\S\\n]+(?i:identity)[^\\S\\n]+(?i:card))` +
    `(?:` +
    `[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|(?i:n[°ºo]\\.?))` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}[A-Za-z0-9]{9,12}` +
    `|[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `(?=[A-Za-z0-9]{0,11}\\d)[A-Za-z0-9]{9,12}` +
    `)\\b`,
  label: "identity card number",
  score: 0.96,
  lazy: true,
  prefilterAny: ["CNI", "carte nationale", "French national identity card"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const CY_TIC_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?:(?i:Cyprus)|(?i:Cypriot))[^\\S\\n]{1,4})?` +
    `(?:(?i:TIC)|(?i:tax)[^\\S\\n]+(?i:identification)[^\\S\\n]+(?i:code))` +
    `(?:[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))?` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `\\d{8}[A-Za-z]\\b`,
  label: "tax identification number",
  score: 0.96,
  lazy: true,
  prefilterAny: ["TIC", "tax identification code"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const CY_ID_CARD_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?i:Cyprus)|(?i:Cypriot))[^\\S\\n]+` +
    `(?:(?i:identity)[^\\S\\n]+(?i:card)|(?i:ID)[^\\S\\n]+(?i:card))` +
    `(?:[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))?` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `\\d{6,8}\\b`,
  label: "identity card number",
  score: 0.96,
  lazy: true,
  prefilterAny: ["Cyprus", "Cypriot", "identity card", "ID card"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const UK_DRIVING_LICENCE_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?:(?i:UK)|(?i:U\\.?K\\.?)|(?i:British))[^\\S\\n]{1,4})?` +
    `(?i:driving)[^\\S\\n]+(?i:licen[cs]e)` +
    `(?:[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#))?` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `[A-Za-z9]{5}\\d{6}[A-Za-z0-9]{2}\\d[A-Za-z]{2}\\b`,
  label: "identity card number",
  score: 0.96,
  lazy: true,
  prefilterAny: ["driving licence", "driving license"],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const US_DRIVER_LICENSE_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:(?:(?i:U\\.?S\\.?)|(?i:USA)|(?i:United)[^\\S\\n]+(?i:States)|${US_STATE_CODE})` +
    `[^\\S\\n]{1,4})?(?:(?i:driver['’]?s?)|(?i:driving))[^\\S\\n]+(?i:licen[cs]e)` +
    `(?:` +
    `[^\\S\\n]+(?:(?i:number)|(?i:no\\.?)|#)` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}[A-Za-z0-9]{5,15}` +
    `|[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `(?=[A-Za-z0-9]{0,14}\\d)[A-Za-z0-9]{5,15}` +
    `)\\b`,
  label: "identity card number",
  score: 0.8,
  lazy: true,
  prefilterAny: [
    "driver license",
    "driver licence",
    "drivers license",
    "drivers licence",
    "driver's license",
    "driver's licence",
    "driver’s license",
    "driver’s licence",
    "driving license",
    "driving licence",
  ],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const MEDICAL_LICENSE_CONTEXT: RegexDef = {
  pattern:
    `\\b(?:` +
    `(?:(?i:GMC)|(?i:NMC))` +
    `(?:[^\\S\\n]+(?:(?i:licen[cs]e)|(?i:registration)|(?i:reg\\.?)|(?i:pin)|(?i:number)|(?i:no\\.?)))*` +
    `|(?:(?i:medical)|(?i:physician)|(?i:doctor)|(?i:surgeon)|(?i:nursing)|(?i:nurse))` +
    `(?:[^\\S\\n]+(?:(?i:licen[cs]e)|(?i:registration)|(?i:reg\\.?)|(?i:pin)|(?i:number)|(?i:no\\.?)))+` +
    `)` +
    `[^\\S\\n]{0,4}:?[^\\S\\n]{0,4}` +
    `(?:[A-Za-z]{0,3}\\d{5,8}|\\d{2}[A-Za-z]\\d{4}[A-Za-z])\\b`,
  label: "registration number",
  score: 0.85,
  lazy: true,
  prefilterAny: [
    "GMC",
    "NMC",
    "medical",
    "physician",
    "doctor",
    "surgeon",
    "nursing",
    "nurse",
  ],
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const CRYPTO_WALLET_CANDIDATE = crypto.wallet.candidatePattern ?? "(?!)";
const CRYPTO_WALLET_CANDIDATE_REGEX = new RegExp(CRYPTO_WALLET_CANDIDATE);
const getCryptoWalletCandidate = (text: string): string =>
  CRYPTO_WALLET_CANDIDATE_REGEX.exec(text)?.[0] ?? text;

const CRYPTO_WALLET_ADDRESS: RegexDef = {
  pattern:
    `\\b(?:0x[0-9A-Fa-f]{40}` +
    `|bc1[ac-hj-np-z02-9]{11,71}` +
    `|BC1[AC-HJ-NP-Z02-9]{11,71})\\b` +
    `|\\b(?:(?i:BTC|Bitcoin|crypto|wallet|address)[^\\S\\n]{0,4}:?[^\\S\\n]{1,8}){1,4}` +
    `[13][a-km-zA-HJ-NP-Z1-9]{25,34}\\b`,
  label: "crypto",
  score: 0.85,
  validator: crypto.wallet,
  validatorInput: getCryptoWalletCandidate,
  validatorInputKind: "crypto-wallet-candidate",
  lazy: true,
  prefilterAny: ["0x", "bc1", "BTC", "Bitcoin", "crypto", "wallet", "address"],
  prefilterCaseInsensitive: true,
};

const AU_ABN_FORMATTED: RegexDef = {
  pattern: `\\b\\d{2}[^\\S\\n]\\d{3}[^\\S\\n]\\d{3}[^\\S\\n]\\d{3}\\b`,
  label: "tax identification number",
  score: 0.95,
  validator: au.abn,
};

const NO_ORGNR_FORMATTED: RegexDef = {
  pattern: `\\b\\d{3}[^\\S\\n]\\d{3}[^\\S\\n]\\d{3}\\b`,
  label: "registration number",
  score: 0.9,
  validator: no.orgnr,
};

const NO_MVA_FORMATTED: RegexDef = {
  pattern:
    `\\bNO[^\\S\\n]?\\d{3}[^\\S\\n]?\\d{3}` +
    `[^\\S\\n]?\\d{3}[^\\S\\n]?MVA\\b`,
  label: "tax identification number",
  score: 0.95,
  validator: no.mva,
  lazy: true,
  prefilterAny: ["MVA"],
  prefilterCaseInsensitive: false,
};

const US_EIN_FORMATTED: RegexDef = {
  pattern: `\\b\\d{2}${DASH}\\d{7}\\b`,
  label: "tax identification number",
  score: 0.95,
  validator: us.ein,
};

// Brazilian CEP (Código de Endereçamento Postal):
// NNNNN-NNN. Distinctive 5-digit + hyphen + 3-digit
// shape, but the bare form is indistinguishable from
// non-address order/ticket/reference numbers
// ("Order 12345-678"), so it is not emitted as an
// active address regex. Instead the shape is consumed
// by `processAddressSeeds` as a postal-code seed, so
// expansion only fires when other street/city signals
// cluster around it (e.g.
// "Rua Augusta, 123, 01001-000 São Paulo").
//
// Kept here as documentation only.

// Brazilian CPF (personal tax ID), formatted form
// only: NNN.NNN.NNN-NN. Dotted/dashed form is matched
// by the distinctive separators; the br.cpf validator
// rejects placeholder values such as "000.000.000-00"
// or other invalid checksums.
//
// Score must beat the generic phone patterns so the
// overlap resolver assigns the tax-ID label.
const BR_CPF_FORMATTED: RegexDef = {
  pattern: `\\b\\d{3}\\.\\d{3}\\.\\d{3}${DASH}\\d{2}\\b`,
  label: "tax identification number",
  score: 0.95,
  validator: br.cpf,
};

// Brazilian CNPJ (company tax ID), formatted:
// NN.NNN.NNN/NNNN-NN. The slash is unique to CNPJ
// for shape, and the br.cnpj validator filters
// placeholder values such as "12.345.678/0001-00".
const BR_CNPJ_FORMATTED: RegexDef = {
  pattern: `\\b\\d{2}\\.\\d{3}\\.\\d{3}/\\d{4}${DASH}\\d{2}\\b`,
  label: "tax identification number",
  score: 0.95,
  validator: br.cnpj,
};

// Brazilian RG (Registro Geral, state-issued identity).
// Format is non-uniform across states; the most reliable
// anchor is the trailing "SSP/UF" issuer marker. Captures
// the number and the SSP suffix.
//   12.345.678 SSP/DF
//   45.678.901-2 SSP/SP
//   32.456.789-X SSP/SP
const BR_RG_WITH_SSP: RegexDef = {
  pattern:
    `\\b\\d{1,3}\\.?\\d{3}\\.?\\d{3}` +
    `(?:${DASH}[0-9A-Za-z])?` +
    `[^\\S\\n]+SSP(?:/[A-Z]{2})?\\b`,
  label: "national identification number",
  score: 0.95,
  lazy: true,
  prefilterAny: ["SSP"],
  prefilterCaseInsensitive: false,
};

// Brazilian OAB (lawyer registration). Format:
// "OAB/UF NNNNNN" or "OAB/UF NNN.NNN" — two-letter
// state code, optional "nº" / "n." marker, then 4–6
// digits with optional thousand separator dot.
const BR_OAB: RegexDef = {
  pattern:
    `\\bOAB/[A-Z]{2}[^\\S\\n]+(?:n[º°.][^\\S\\n]*)?` +
    `(?:\\d{1,3}(?:\\.\\d{3})+|\\d{4,6})\\b`,
  label: "registration number",
  score: 0.95,
  lazy: true,
  prefilterAny: ["OAB/"],
  prefilterCaseInsensitive: false,
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
  lazy: true,
  prefilterAny: ["http://", "https://", "http:", "https:", "www."],
  prefilterCaseInsensitive: false,
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
  "com|org|net|eu|cz|sk|pl|hu|ro|fr|es" + "|co\\.uk|nl|ch|info|io|dev";
const SHORT_TLDS = "de|at|be|se|fi|dk|no|it|uk";
// RFC 1123: labels cannot start or end with hyphen.
const HOST_LABEL = `[a-zA-Z0-9](?:[a-zA-Z0-9\\-]*[a-zA-Z0-9])?`;
const BARE_HOST = `\\b[a-zA-Z0-9][a-zA-Z0-9\\-]+[a-zA-Z0-9]`;
const PATH_SUFFIX = `(?:[/?#][^\\s)\\]>]*[^\\s.,;:!?)\\]>])?`;
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

// UK postcode (standard outward + inward). Covers:
//   "SW1A 1AA", "EC4A 1AB", "M1 1AE", "B33 8TH",
//   "CR2 6XH", "DN55 1PT", "GIR 0AA" (Girobank).
// Strict format: outward area letter(s) + digit/digit
// (or digit+letter) + space + inward digit + 2 letters.
// Space between outward and inward is optional in
// freely-typed text.
const UK_POSTCODE: RegexDef = {
  pattern:
    `\\b(?:` +
    // GIR 0AA — historic Girobank postcode
    `GIR[^\\S\\n]?0AA` +
    `|` +
    // Standard outward (1-2 letters, 1-2 digits, opt. letter)
    `[A-PR-UWYZ](?:[A-HK-Y][0-9](?:[0-9]|[ABEHMNPRV-Y])?|[0-9](?:[0-9]|[A-HJKPS-UW])?)` +
    `[^\\S\\n]?[0-9][ABD-HJLNP-UW-Z]{2}` +
    `)\\b`,
  label: "address",
  score: 0.9,
};

// UK National Insurance Number. Two-letter prefix +
// six digits + optional suffix letter A-D. Per HMRC:
// first letter not D/F/I/Q/U/V; second letter not
// D/F/I/O/Q/U/V; and several explicit prefix blocks
// (BG, GB, KN, NK, NT, TN, ZZ). The character classes
// here enforce the per-position letter rules; the
// stdnum `gb.nino` validator handles the blocked
// prefixes at post-match time. Negative lookaheads
// are avoided because the Rust DFA upstream rejects
// them. Optional spaces between segments cover the
// common printed form `AB 12 34 56 C` — stdnum's own
// candidatePattern (`[A-Z]{2}\d{6}[A-Z]`) misses it.
const UK_NINO: RegexDef = {
  pattern:
    `\\b[A-CEGHJ-PR-TWXYZ][A-CEGHJ-NPR-TWXYZ]` +
    `[^\\S\\n]?\\d{2}[^\\S\\n]?\\d{2}[^\\S\\n]?\\d{2}` +
    `[^\\S\\n]?[A-D]?\\b`,
  label: "social security number",
  score: 0.95,
  validator: gb.nino,
};

// 12-hour time: "5:00 p.m.", "12:30 AM", "5:00p.m.",
// "11:00 a.m. Eastern Time". Captures HH:MM and the
// am/pm marker; optional timezone suffix is not
// included (it's not PII). Case spelled out explicitly
// (no (?i)) because DFA compilation fails with
// Unicode + case-insensitive flag on this pattern.
const TIME_12H: RegexDef = {
  pattern:
    `\\b(?:1[0-2]|0?[1-9]):[0-5]\\d` +
    `[^\\S\\n]?(?:[aApP]\\.?[mM]\\.?)` +
    `(?=[\\s,;!?)]|$)`,
  label: "date",
  score: 0.9,
  lazy: true,
  prefilterAny: ["am", "pm", "a.m", "p.m"],
  prefilterCaseInsensitive: true,
};

const PERCENT_NUMBER_BODY = `(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,4})?|\\d+(?:[.,]\\d{1,4})?)`;
const PERCENT_NUMBER = `(?:[+${DASH_INNER}])?${PERCENT_NUMBER_BODY}`;
const PERCENT_TOKEN = `${PERCENT_NUMBER}[^\\S\\n]{0,2}%`;
const PERCENT_RANGE_NUMBER = `\\d+(?:[.,]\\d{1,4})?`;
const PERCENT_RANGE =
  `${PERCENT_RANGE_NUMBER}[^\\S\\n]*${DASH}[^\\S\\n]*` +
  `${PERCENT_RANGE_NUMBER}[^\\S\\n]{0,2}%`;
const PERCENT_LEFT_BOUNDARY = "(?<![\\p{L}\\p{N}_.,])";
const PERCENT_RIGHT_BOUNDARY = "(?![\\p{L}\\p{N}_])";

const buildPercentWordPattern = (config: AmountWordsConfig): string => {
  const phrases: string[] = [];
  for (const entry of config.percentages ?? []) {
    const ones = entry.ones.map(escapeRegex);
    const standalone = (entry.standalone ?? []).map(escapeRegex);
    const baseWords = [...ones, ...entry.teens, ...entry.tens].map(escapeRegex);
    const compoundSeparator = entry.allowSpaceCompoundSeparator
      ? `(?:${DASH}|[^\\S\\n]+)`
      : DASH;
    const compound =
      `(?:${baseWords.join("|")})` +
      (ones.length > 0 ? `(?:${compoundSeparator}(?:${ones.join("|")}))?` : "");
    const word = `(?:${[...standalone, compound].join("|")})`;
    const keyword = `(?:${entry.keywords.map(escapeRegex).join("|")})`;
    phrases.push(`${word}[^\\S\\n]+${keyword}`);
  }
  return phrases.length > 0 ? `(?i:(?:${phrases.join("|")}))` : "(?!)";
};

const PERCENT_WORD = buildPercentWordPattern(AMOUNT_WORDS);
const PERCENT_WORD_PREFILTERS = [
  ...new Set(
    (AMOUNT_WORDS.percentages ?? []).flatMap((entry) => entry.keywords),
  ),
];

// Percentages and financial rates. Captures signed numeric
// values with dot or comma decimals, grouped thousands, and
// locale-style spacing before `%`. Also widens written-out
// legal thresholds paired with a numeric parenthetical
// (`fifty percent (50%)`) so the text does not disclose the
// exact value after only the parenthesized token is redacted.
// Percentages are not classically personally identifying, but
// in legal text they routinely fingerprint specific debt
// instruments (`3.875% Senior Notes due 2027`) and tax
// brackets; labelling them as `monetary amount` keeps the
// operator-side handling consistent with how other quantitative
// identifiers are redacted.
const PERCENT_WORD_RATE: RegexDef = {
  pattern:
    `${PERCENT_LEFT_BOUNDARY}` +
    `${PERCENT_WORD}[^\\S\\n]*\\([^\\S\\n]*${PERCENT_TOKEN}[^\\S\\n]*\\)` +
    PERCENT_RIGHT_BOUNDARY,
  label: "monetary amount",
  score: 0.85,
  lazy: true,
  prefilterAny: PERCENT_WORD_PREFILTERS,
  prefilterCaseInsensitive: true,
  prefilterWindowBytes: CONTEXT_REGEX_PREFILTER_WINDOW_BYTES,
};

const PERCENT_NUMERIC_RATE: RegexDef = {
  pattern:
    `${PERCENT_LEFT_BOUNDARY}(?:${PERCENT_RANGE}|${PERCENT_TOKEN})` +
    PERCENT_RIGHT_BOUNDARY,
  label: "monetary amount",
  score: 0.85,
  lazy: true,
  prefilterAny: ["%"],
  prefilterCaseInsensitive: false,
};

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
  POSTNOMINAL_PERSON,
  IBAN,
  EMAIL,
  INTL_PHONE,
  CZ_PHONE,
  TEL_PREFIX_PHONE,
  US_PAREN_PHONE,
  CREDIT_CARD,
  CZ_BIRTH_NUMBER,
  CZ_COMMERCIAL_REGISTER,
  DATE_NUMERIC,
  DATE_CZ_SPACED,
  IP_ADDRESS,
  CZ_BANK_ACCOUNT,
  HU_LANDLINE,
  CZ_POSTAL,
  ES_POSTAL,
  ES_DNI,
  ES_NIE,
  ES_CIF,
  NHS_NUMBER_CONTEXT,
  PASSPORT_CONTEXT,
  FR_CNI_CONTEXT,
  CY_TIC_CONTEXT,
  CY_ID_CARD_CONTEXT,
  UK_DRIVING_LICENCE_CONTEXT,
  US_DRIVER_LICENSE_CONTEXT,
  MEDICAL_LICENSE_CONTEXT,
  CRYPTO_WALLET_ADDRESS,
  AU_ABN_FORMATTED,
  NO_ORGNR_FORMATTED,
  NO_MVA_FORMATTED,
  US_EIN_FORMATTED,
  BR_CPF_FORMATTED,
  BR_CNPJ_FORMATTED,
  BR_RG_WITH_SSP,
  BR_OAB,
  URL,
  IPV6_ADDRESS,
  MAC_ADDRESS,
  BARE_DOMAIN,
  UK_POSTCODE,
  UK_NINO,
  TIME_12H,
  PERCENT_WORD_RATE,
  PERCENT_NUMERIC_RATE,
  ...STDNUM_ENTRIES,
];

/** Flat pattern array for text-search. */
export const REGEX_PATTERNS: readonly string[] = ALL_REGEX_DEFS.map(
  (d) => d.pattern,
);

const toRegexPatternEntry = (definition: RegexDef): PatternEntry => {
  if (
    definition.lazy === undefined &&
    definition.prefilterAny === undefined &&
    definition.prefilterCaseInsensitive === undefined &&
    definition.prefilterRegex === undefined &&
    definition.prefilterWindowBytes === undefined
  ) {
    return definition.pattern;
  }

  const entry: RegexPatternEntry = { pattern: definition.pattern };
  if (definition.lazy !== undefined) {
    entry.lazy = definition.lazy;
  }
  if (definition.prefilterAny !== undefined) {
    entry.prefilterAny = definition.prefilterAny;
  }
  if (definition.prefilterCaseInsensitive !== undefined) {
    entry.prefilterCaseInsensitive = definition.prefilterCaseInsensitive;
  }
  if (definition.prefilterRegex !== undefined) {
    entry.prefilterRegex = definition.prefilterRegex;
  }
  if (definition.prefilterWindowBytes !== undefined) {
    entry.prefilterWindowBytes = definition.prefilterWindowBytes;
  }
  return entry;
};

/** Static regex entries with compile-time prefilter hints. */
export const REGEX_PATTERN_ENTRIES: readonly PatternEntry[] =
  ALL_REGEX_DEFS.map(toRegexPatternEntry);

/** Parallel metadata. Index = pattern index. */
export const REGEX_META: readonly RegexMeta[] = ALL_REGEX_DEFS.map(
  (d): RegexMeta => {
    const meta: RegexMeta = {
      label: d.label,
      score: d.score,
    };
    if (d.validator) {
      meta.validator = d.validator;
      const validatorId = d.validatorId ?? VALIDATOR_IDS.get(d.validator);
      if (!validatorId) {
        throw new Error(`Missing regex validator id for ${d.label}`);
      }
      meta.validatorId = validatorId;
    }
    if (d.minByteLength) {
      meta.minByteLength = d.minByteLength;
    }
    if (d.validatorInput) {
      meta.validatorInput = d.validatorInput;
      if (!d.validatorInputKind) {
        throw new Error(`Missing regex validator input kind for ${d.label}`);
      }
      meta.validatorInputKind = d.validatorInputKind;
    }
    return meta;
  },
);

// ── Dynamic date patterns (22 languages) ────────────

/**
 * JSON shape: language codes map to string arrays;
 * metadata keys (prefixed `_`) map to strings.
 * The `_` keys are skipped by `buildMonthAlternation`.
 */
type DateMonths = Record<string, string[] | string>;

export type DateMonthData = Record<string, string[]>;
export type YearWordData = Record<string, string[]>;

const languageCacheKey = (languages: readonly string[] | undefined): string => {
  if (languages === undefined || languages.length === 0) {
    return "*";
  }
  return [...new Set(languages.map(normalizeLanguageKey).filter(Boolean))]
    .toSorted()
    .join(",");
};

const normalizeLanguageKey = (language: string): string =>
  language.trim().toLowerCase();

const selectedLanguageKeys = (
  languages: readonly string[] | undefined,
): ReadonlySet<string> | null => {
  if (languages === undefined || languages.length === 0) {
    return null;
  }
  const selected = new Set<string>();
  for (const language of languages) {
    const normalized = normalizeLanguageKey(language);
    if (normalized.length === 0) {
      continue;
    }
    selected.add(normalized);
    const separator = normalized.indexOf("-");
    if (separator !== -1) {
      selected.add(normalized.slice(0, separator));
    }
  }
  return selected.size === 0 ? null : selected;
};

const filterDateMonthsByLanguage = (
  months: DateMonths,
  languages: readonly string[] | undefined,
): DateMonths => {
  const selected = selectedLanguageKeys(languages);
  if (selected === null) {
    return months;
  }

  const filtered: DateMonths = {};
  for (const [key, value] of Object.entries(months)) {
    if (key.startsWith("_") || !selected.has(normalizeLanguageKey(key))) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length === 0 ? months : filtered;
};

const filterYearWordsByLanguage = (
  data: Record<string, unknown>,
  languages: readonly string[] | undefined,
): Record<string, unknown> => {
  const selected = selectedLanguageKeys(languages);
  if (selected === null) {
    return data;
  }

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("_") || !selected.has(normalizeLanguageKey(key))) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length === 0 ? data : filtered;
};

/**
 * Build month-name alternation from date-months.json.
 * Deduplicates across all 22 languages, filters names
 * shorter than 3 chars (too many false positives), and
 * sorts longest-first so the regex engine prefers the
 * longest match.
 */
const buildMonthAlternation = (months: DateMonths): string => {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(months)) {
    if (key.startsWith("_")) continue;
    const names = Array.isArray(value) ? value : [value];
    for (const name of names) {
      // Strip trailing dots for the regex; date patterns
      // use `\\.?` after the alternation to match optional
      // abbreviation dots.
      const clean = name.replace(/\.$/, "").toLowerCase();
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

const buildDateMonthData = (months: DateMonths): DateMonthData => {
  const result: DateMonthData = {};
  for (const [key, value] of Object.entries(months)) {
    if (key.startsWith("_")) continue;
    const names = Array.isArray(value) ? value : [value];
    result[key] = names.filter(
      (name) => name.replace(/\.$/, "").length >= MIN_MONTH_NAME_LENGTH,
    );
  }
  return result;
};

/**
 * Build date patterns from a month-name alternation.
 * Returns 6 patterns covering the major written-date
 * formats across all supported languages.
 */
const buildDatePatternsFromMonths = (alt: string): string[] => {
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
    // g. Month[.] DD — "December 31" (no year, US format)
    `(?i)\\b(?:${alt})\\.?\\s+\\d{1,2}(?=\\s|[.,;!?)]|$)`,
    // c. DDst/nd/rd/th Month[.] [YYYY] — "1st January 2025"
    `(?i)\\b\\d{1,2}(?:st|nd|rd|th)\\s+(?:${alt})\\.?` +
      `(?:\\s+\\d{4})?(?=\\s|[.,;!?)]|$)`,
    // d. Month[.] YYYY — "October 1983"
    `(?i)\\b(?:${alt})\\.?\\s+\\d{4}\\b`,
    // e. YYYY. Month[.] DD. — Hungarian "2025. január 7."
    `(?i)\\b\\d{4}\\.\\s+(?:${alt})\\.?\\s+\\d{1,2}\\.?(?=\\s|[.,;!?)]|$)`,
    // f. DD de Month[.] [de] YYYY — Spanish "7 de enero de 2025"
    `(?i)\\b\\d{1,2}\\s+de\\s+(?:${alt})\\.?` + `(?:\\s+de)?\\s+\\d{4}\\b`,
  ];
};

/** Cached promise for date patterns. Loaded once. */
const datePatternPromises = new Map<string, Promise<string[]>>();
const dateMonthDataPromises = new Map<string, Promise<DateMonthData>>();
const yearWordDataPromises = new Map<string, Promise<YearWordData>>();

const loadDateMonths = async (): Promise<DateMonths> => {
  const mod = await import("../data/date-months.json");
  // Dynamic import of JSON returns { default, ...keys }.
  // Use `default` if present (ESM wrapper), else the
  // module itself.
  return mod.default ?? mod;
};

const loadDatePatterns = async (
  languages?: readonly string[],
): Promise<string[]> => {
  const months = await loadDateMonths();
  const alt = buildMonthAlternation(
    filterDateMonthsByLanguage(months, languages),
  );
  return buildDatePatternsFromMonths(alt);
};

/**
 * Get dynamically built date patterns from
 * date-months.json. Returns a cached promise; the JSON
 * is loaded only once.
 */
export const getDatePatterns = (
  languages?: readonly string[],
): Promise<string[]> => {
  const key = languageCacheKey(languages);
  let promise = datePatternPromises.get(key);
  if (promise === undefined) {
    promise = loadDatePatterns(languages).catch((err) => {
      datePatternPromises.delete(key);
      throw err;
    });
    datePatternPromises.set(key, promise);
  }
  return promise;
};

export const getDateMonthData = (
  languages?: readonly string[],
): Promise<DateMonthData> => {
  const key = languageCacheKey(languages);
  let promise = dateMonthDataPromises.get(key);
  if (promise === undefined) {
    promise = loadDateMonths()
      .then((months) =>
        buildDateMonthData(filterDateMonthsByLanguage(months, languages)),
      )
      .catch((err) => {
        dateMonthDataPromises.delete(key);
        throw err;
      });
    dateMonthDataPromises.set(key, promise);
  }
  return promise;
};

export const getYearWordData = (
  languages?: readonly string[],
): Promise<YearWordData> => {
  const key = languageCacheKey(languages);
  let promise = yearWordDataPromises.get(key);
  if (promise !== undefined) {
    return promise;
  }
  promise = import("../data/year-words.json")
    .then((mod) => {
      const data = (mod.default ?? mod) as Record<string, unknown>;
      const scopedData = filterYearWordsByLanguage(data, languages);
      const result: YearWordData = {};
      for (const [language, words] of Object.entries(scopedData)) {
        if (language.startsWith("_") || !Array.isArray(words)) {
          continue;
        }
        result[language] = words.filter(
          (word): word is string => typeof word === "string" && word.length > 0,
        );
      }
      return result;
    })
    .catch((err) => {
      yearWordDataPromises.delete(key);
      throw err;
    });
  yearWordDataPromises.set(key, promise);
  return promise;
};

/** Date pattern metadata (all are score 1 dates). */
export const DATE_PATTERN_META: Readonly<RegexMeta> = Object.freeze({
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

export type MonetaryData = {
  currencies: {
    codes: string[];
    symbols: string[];
    local_names: string[];
  };
  amount_words: {
    written_amount_patterns: Array<{
      keywords: string[];
    }>;
    magnitude_suffixes: Array<{
      words: string[];
      abbreviations_case_insensitive: string[];
      abbreviations_case_sensitive: string[];
    }>;
    share_quantity_terms: Array<{
      modifiers: string[];
      nouns: string[];
    }>;
  };
};

type FinancialLexicons = {
  magnitudeOptional: string;
  magnitudeRequired: string;
  magnitudePrefilterTerms: readonly string[];
  quantityFollowerGuard: string;
};

type CurrencyPatternEntry = {
  pattern: string;
  literal?: false;
  lazy: true;
  prefilterAny: readonly string[];
  prefilterCaseInsensitive: boolean;
  prefilterRegex?: RegExp;
};

type MagnitudePattern = {
  optional: string;
  required: string;
  prefilterTerms: readonly string[];
};

const buildMagnitudePattern = (config: AmountWordsConfig): MagnitudePattern => {
  const words: string[] = [];
  const caseInsensitiveAbbreviations: string[] = [];
  const caseSensitiveAbbreviations: string[] = [];

  for (const entry of config.magnitudeSuffixes ?? []) {
    words.push(...(entry.words ?? []));
    caseInsensitiveAbbreviations.push(
      ...(entry.abbreviationsCaseInsensitive ?? []),
    );
    caseSensitiveAbbreviations.push(
      ...(entry.abbreviationsCaseSensitive ?? []),
    );
  }

  const branches: string[] = [];
  const wordsAlt = toSortedAlternation(words);
  const abbreviationCiAlt = toSortedAlternation(caseInsensitiveAbbreviations);
  const abbreviationCsAlt = toSortedAlternation(caseSensitiveAbbreviations);

  if (wordsAlt) {
    branches.push(`[^\\S\\n\\t]+(?i:(?:${wordsAlt}))\\b`);
  }
  if (abbreviationCiAlt) {
    branches.push(`[^\\S\\n\\t]?(?i:${abbreviationCiAlt})\\b`);
  }
  if (abbreviationCsAlt) {
    branches.push(`[^\\S\\n\\t]?(?:${abbreviationCsAlt})\\b`);
  }

  const required = branches.length > 0 ? `(?:${branches.join("|")})` : "";
  return {
    optional: required ? `${required}?` : "",
    required,
    prefilterTerms: [
      ...words,
      ...caseInsensitiveAbbreviations,
      ...caseSensitiveAbbreviations,
    ],
  };
};

const buildQuantityFollowerGuard = (config: AmountWordsConfig): string => {
  const modifiers: string[] = [];
  const nouns: string[] = [];

  for (const entry of config.shareQuantityTerms ?? []) {
    modifiers.push(...(entry.modifiers ?? []));
    nouns.push(...entry.nouns);
  }

  const modifierAlt = toSortedAlternation(modifiers);
  const nounAlt = toSortedAlternation(nouns);
  if (!nounAlt) return "";

  const modifierPrefix = modifierAlt
    ? `(?:(?:${modifierAlt})[^\\S\\n\\t]+){0,3}`
    : "";

  return `(?![^\\S\\n\\t]+(?i:` + `${modifierPrefix}(?:${nounAlt}))\\b)`;
};

const buildFinancialLexicons = (
  config: AmountWordsConfig,
): FinancialLexicons => {
  const magnitude = buildMagnitudePattern(config);
  return Object.freeze({
    magnitudeOptional: magnitude.optional,
    magnitudeRequired: magnitude.required,
    magnitudePrefilterTerms: magnitude.prefilterTerms,
    quantityFollowerGuard: buildQuantityFollowerGuard(config),
  });
};

const FINANCIAL_LEXICONS = buildFinancialLexicons(AMOUNT_WORDS);

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
const buildCurrencyPatternEntries = (
  data: CurrenciesData,
): CurrencyPatternEntry[] => {
  const symbols = data.symbols.map(escapeCharClass).join("");

  // Build trailing alternation: ISO codes (case-
  // sensitive, always uppercase) + local names.
  // Local names that contain only ASCII letters
  // are wrapped in (?i:...) for case-insensitive
  // matching; abbreviations with non-ASCII or
  // punctuation (Kč, zł, Fr.) stay case-sensitive.
  // Sorted longest-first to avoid partial matches.
  const isAsciiAlpha = /^[a-zA-Z\s]+$/;

  type CurrencyTermPart = { term: string; len: number; alt: string };
  const codeParts: CurrencyTermPart[] = data.codes.map((code) => ({
    term: code,
    len: code.length,
    alt: escapeRegex(code),
  }));
  const localNameParts: CurrencyTermPart[] = [];

  // Minimum length for case-insensitive wrapping.
  // Short abbreviations like "Ft" (2 chars) stay
  // case-sensitive to avoid collisions (Ft vs ft/feet).
  const MIN_CI_LENGTH = 3;

  if (data.localNames) {
    for (const name of data.localNames) {
      const escaped = escapeRegex(name);
      const wrapCI = isAsciiAlpha.test(name) && name.length >= MIN_CI_LENGTH;
      if (wrapCI) {
        localNameParts.push({
          term: name,
          len: name.length,
          alt: `(?i:${escaped})`,
        });
      } else {
        localNameParts.push({
          term: name,
          len: name.length,
          alt: escaped,
        });
      }
    }
  }

  // Also include currency symbols as trailing
  // alternatives (e.g., "126 €", "8 190 £").
  // These are common in European notation.
  const toPartAlternation = (parts: readonly CurrencyTermPart[]): string =>
    parts
      .toSorted((a, b) => b.len - a.len)
      .map((p) => p.alt)
      .join("|");
  const codeAlt = toPartAlternation(codeParts);
  const localNameAlt = toPartAlternation(localNameParts);
  const codeTerms = codeParts.map((part) => part.term);
  const localNameTerms = localNameParts.map((part) => part.term);
  const trailingAlt = [...codeParts, ...localNameParts]
    .toSorted((a, b) => b.len - a.len)
    .map((p) => p.alt)
    .join("|");

  if (!symbols && !trailingAlt) return [];

  // Number sub-pattern: grouped thousands OR plain
  // integer up to 9 digits (covers unformatted
  // amounts like "100000 CZK").
  const NUM = `(?:\\d{1,3}(?:[,.'[^\\S\\n\\t]]\\d{3})+` + `|\\d{1,9})`;
  const PREFILTER_NUM = `(?:\\d{1,3}(?:[,.'\\s]\\d{3})+|\\d{1,9})`;
  const PREFILTER_DECIMAL =
    `(?:[.,](?=\\d|[${DASH_INNER}])` +
    `\\s?(?:\\d{1,2}${DASH}?|${DASH}{1,2}))?`;

  const patterns: CurrencyPatternEntry[] = [];
  const lazyCurrencyPattern = (
    pattern: string,
    prefilterAny: readonly string[],
    prefilterCaseInsensitive: boolean,
    prefilterRegex?: RegExp,
  ): CurrencyPatternEntry => ({
    pattern,
    lazy: true,
    prefilterAny,
    prefilterCaseInsensitive,
    ...(prefilterRegex ? { prefilterRegex } : {}),
  });
  const makeLeadingPrefilter = (
    terms: readonly string[],
    caseInsensitive: boolean,
  ): RegExp | undefined => {
    const termAlt = toSortedAlternation(terms);
    if (!termAlt) return undefined;
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])(?:${termAlt})[^\\S\\n\\t]{0,2}\\d`,
      caseInsensitive ? "iu" : "u",
    );
  };
  const makeTrailingPrefilter = (
    terms: readonly string[],
    caseInsensitive: boolean,
  ): RegExp | undefined => {
    const termAlt = toSortedAlternation(terms);
    if (!termAlt) return undefined;
    return new RegExp(
      `${PREFILTER_NUM}${PREFILTER_DECIMAL}[^\\S\\n\\t]{0,4}(?:${termAlt})`,
      caseInsensitive ? "iu" : "u",
    );
  };
  const makeLeadingMagnitudePrefilter = (
    terms: readonly string[],
    caseInsensitive: boolean,
  ): RegExp | undefined => {
    const termAlt = toSortedAlternation(terms);
    const magnitudeAlt = toSortedAlternation(
      FINANCIAL_LEXICONS.magnitudePrefilterTerms,
    );
    if (!termAlt || !magnitudeAlt) return undefined;
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])(?:${termAlt})` +
        `[^\\S\\n\\t]{0,2}${PREFILTER_NUM}${PREFILTER_DECIMAL}` +
        `[^\\S\\n\\t]{0,8}(?:${magnitudeAlt})(?:$|[^\\p{L}\\p{N}_])`,
      caseInsensitive ? "iu" : "u",
    );
  };
  const makeLeadingSymbolMagnitudePrefilter = (): RegExp | undefined => {
    const magnitudeAlt = toSortedAlternation(
      FINANCIAL_LEXICONS.magnitudePrefilterTerms,
    );
    if (!magnitudeAlt) return undefined;
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])(?:[${symbols}])` +
        `[^\\S\\n\\t]{0,2}${PREFILTER_NUM}${PREFILTER_DECIMAL}` +
        `[^\\S\\n\\t]{0,8}(?:${magnitudeAlt})(?:$|[^\\p{L}\\p{N}_])`,
      "iu",
    );
  };
  const makeTrailingMagnitudePrefilter = (
    terms: readonly string[],
    caseInsensitive: boolean,
  ): RegExp | undefined => {
    const termAlt = toSortedAlternation(terms);
    const magnitudeAlt = toSortedAlternation(
      FINANCIAL_LEXICONS.magnitudePrefilterTerms,
    );
    if (!termAlt || !magnitudeAlt) return undefined;
    return new RegExp(
      `${PREFILTER_NUM}${PREFILTER_DECIMAL}` +
        `[^\\S\\n\\t]{0,8}(?:${magnitudeAlt})(?:$|[^\\p{L}\\p{N}_])` +
        `[\\s\\S]{0,24}(?:${termAlt})`,
      caseInsensitive ? "iu" : "u",
    );
  };

  // Decimal part: dot/comma must be followed by at
  // least one digit or dash. Without this, a trailing
  // sentence period ("$25,000,000.") gets consumed by
  // the optional group, breaking the \b anchor.
  // Use lookahead (?=\d|DASH) after [.,] to ensure
  // the separator is actually a decimal marker.
  const DECIMAL =
    `(?:[.,](?=\\d|[${DASH_INNER}])` +
    `[^\\S\\n\\t]?` +
    `(?:\\d{1,2}${DASH}?|${DASH}{1,2}))?`;
  const END = `(?:\\b|(?=\\s|[.,;!?)]|$))`;

  const MAGNITUDE_OPTIONAL = FINANCIAL_LEXICONS.magnitudeOptional;
  const MAGNITUDE_REQUIRED = FINANCIAL_LEXICONS.magnitudeRequired;

  // Leading symbol: $100, €1,000.50, € 100000.
  // Magnitude-bearing forms ($25 million, $2bn)
  // are a separate pattern: making the magnitude
  // suffix optional in this very broad symbol pattern
  // forces the regex engine to do much more work on
  // EDGAR-style contracts with large numeric sections.
  if (symbols) {
    patterns.push(
      lazyCurrencyPattern(
        `(?:[${symbols}])` + `[^\\S\\n\\t]?` + `${NUM}${DECIMAL}${END}`,
        data.symbols,
        true,
      ),
    );
    if (MAGNITUDE_REQUIRED) {
      patterns.push(
        lazyCurrencyPattern(
          `(?:[${symbols}])` +
            `[^\\S\\n\\t]?` +
            `${NUM}${DECIMAL}${MAGNITUDE_REQUIRED}${END}`,
          data.symbols,
          true,
          makeLeadingSymbolMagnitudePrefilter(),
        ),
      );
    }
  }

  // Leading multi-char code: "Kč 10,—", "Fr. 500",
  // "EUR 1.5 billion".
  if (codeAlt) {
    patterns.push(
      lazyCurrencyPattern(
        `\\b(?:${codeAlt})` + `[^\\S\\n\\t]{0,2}` + `${NUM}${DECIMAL}${END}`,
        codeTerms,
        false,
        makeLeadingPrefilter(codeTerms, false),
      ),
    );
    if (MAGNITUDE_REQUIRED) {
      patterns.push(
        lazyCurrencyPattern(
          `\\b(?:${codeAlt})` +
            `[^\\S\\n\\t]{0,2}` +
            `${NUM}${DECIMAL}${MAGNITUDE_REQUIRED}${END}`,
          codeTerms,
          false,
          makeLeadingMagnitudePrefilter(codeTerms, false),
        ),
      );
    }
  }
  if (localNameAlt) {
    patterns.push(
      lazyCurrencyPattern(
        `\\b(?:${localNameAlt})` +
          `[^\\S\\n\\t]{0,2}` +
          `${NUM}${DECIMAL}${END}`,
        localNameTerms,
        true,
        makeLeadingPrefilter(localNameTerms, true),
      ),
    );
    if (MAGNITUDE_REQUIRED) {
      patterns.push(
        lazyCurrencyPattern(
          `\\b(?:${localNameAlt})` +
            `[^\\S\\n\\t]{0,2}` +
            `${NUM}${DECIMAL}${MAGNITUDE_REQUIRED}${END}`,
          localNameTerms,
          true,
          makeLeadingMagnitudePrefilter(localNameTerms, true),
        ),
      );
    }
  }

  // Trailing code/name: 100 USD, 1,000.50 CZK,
  // 100000 Kč, 500 korun, 100 Fr., 25 million USD,
  // $25 million USD.
  // Magnitude sits between the number and the code so
  // "100 million USD" parses naturally; the existing
  // 0-4 whitespace span absorbs the separator.
  const optionalLeadingSymbol = symbols
    ? `(?<![\\p{L}\\p{N}_])(?:[${symbols}][^\\S\\n\\t]?)?`
    : "\\b";
  if (codeAlt) {
    patterns.push(
      lazyCurrencyPattern(
        `${optionalLeadingSymbol}${NUM}${DECIMAL}` +
          `[^\\S\\n\\t]{0,4}` +
          `(?:${codeAlt})${END}`,
        codeTerms,
        false,
        makeTrailingPrefilter(codeTerms, false),
      ),
    );
    if (MAGNITUDE_REQUIRED) {
      patterns.push(
        lazyCurrencyPattern(
          `${optionalLeadingSymbol}${NUM}${DECIMAL}${MAGNITUDE_REQUIRED}` +
            `[^\\S\\n\\t]{0,4}` +
            `(?:${codeAlt})${FINANCIAL_LEXICONS.quantityFollowerGuard}${END}`,
          codeTerms,
          false,
          makeTrailingMagnitudePrefilter(codeTerms, false),
        ),
      );
    }
  }
  if (localNameAlt) {
    patterns.push(
      lazyCurrencyPattern(
        `${optionalLeadingSymbol}${NUM}${DECIMAL}` +
          `[^\\S\\n\\t]{0,4}` +
          `(?:${localNameAlt})${END}`,
        localNameTerms,
        true,
        makeTrailingPrefilter(localNameTerms, true),
      ),
    );
    if (MAGNITUDE_REQUIRED) {
      patterns.push(
        lazyCurrencyPattern(
          `${optionalLeadingSymbol}${NUM}${DECIMAL}${MAGNITUDE_REQUIRED}` +
            `[^\\S\\n\\t]{0,4}` +
            `(?:${localNameAlt})${FINANCIAL_LEXICONS.quantityFollowerGuard}${END}`,
          localNameTerms,
          true,
          makeTrailingMagnitudePrefilter(localNameTerms, true),
        ),
      );
    }
  }

  if (symbols) {
    const trailingSymbolPrefilter = new RegExp(
      `${PREFILTER_NUM}${PREFILTER_DECIMAL}[^\\S\\n\\t]{0,4}[${symbols}]`,
      "u",
    );
    patterns.push(
      lazyCurrencyPattern(
        `${NUM}${DECIMAL}${MAGNITUDE_OPTIONAL}` +
          `[^\\S\\n\\t]{0,4}` +
          `(?:[${symbols}])${END}`,
        data.symbols,
        true,
        trailingSymbolPrefilter,
      ),
    );
  }

  return patterns;
};

/** Cached promise for currency patterns. Loaded once. */
let currencyPatternPromise: Promise<string[]> | null = null;
let currencyPatternEntryPromise: Promise<CurrencyPatternEntry[]> | null = null;
let monetaryDataPromise: Promise<MonetaryData> | null = null;

const loadCurrencyPatternEntries = async (): Promise<
  CurrencyPatternEntry[]
> => {
  const mod = await import("../data/currencies.json");
  const data: CurrenciesData = mod.default ?? mod;
  return buildCurrencyPatternEntries(data);
};

const loadCurrencyPatterns = async (): Promise<string[]> =>
  (await loadCurrencyPatternEntries()).map((entry) => entry.pattern);

const loadMonetaryData = async (): Promise<MonetaryData> => {
  const mod = await import("../data/currencies.json");
  const currencies: CurrenciesData = mod.default ?? mod;
  return {
    currencies: {
      codes: currencies.codes,
      symbols: currencies.symbols,
      local_names: currencies.localNames ?? [],
    },
    amount_words: {
      written_amount_patterns: (AMOUNT_WORDS.patterns ?? []).map((entry) => ({
        keywords: entry.keywords,
      })),
      magnitude_suffixes: (AMOUNT_WORDS.magnitudeSuffixes ?? []).map(
        (entry) => ({
          words: entry.words ?? [],
          abbreviations_case_insensitive:
            entry.abbreviationsCaseInsensitive ?? [],
          abbreviations_case_sensitive: entry.abbreviationsCaseSensitive ?? [],
        }),
      ),
      share_quantity_terms: (AMOUNT_WORDS.shareQuantityTerms ?? []).map(
        (entry) => ({
          modifiers: entry.modifiers ?? [],
          nouns: entry.nouns,
        }),
      ),
    },
  };
};

/**
 * Get dynamically built monetary amount patterns from
 * currencies.json. Returns a cached promise; the JSON
 * is loaded only once.
 */
export const getCurrencyPatterns = (): Promise<string[]> => {
  if (!currencyPatternPromise) {
    currencyPatternPromise = loadCurrencyPatterns().catch((err) => {
      currencyPatternPromise = null;
      throw err;
    });
  }
  return currencyPatternPromise;
};

export const getCurrencyPatternEntries = (): Promise<
  CurrencyPatternEntry[]
> => {
  if (!currencyPatternEntryPromise) {
    currencyPatternEntryPromise = loadCurrencyPatternEntries().catch((err) => {
      currencyPatternEntryPromise = null;
      throw err;
    });
  }
  return currencyPatternEntryPromise;
};

export const getMonetaryData = (): Promise<MonetaryData> => {
  if (!monetaryDataPromise) {
    monetaryDataPromise = loadMonetaryData().catch((err) => {
      monetaryDataPromise = null;
      throw err;
    });
  }
  return monetaryDataPromise;
};

/** Currency pattern metadata (score 0.9). */
export const CURRENCY_PATTERN_META: Readonly<RegexMeta> = Object.freeze({
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
      meta.sourceDetail !== "custom-regex" &&
      meta.minByteLength !== undefined &&
      utf8ByteLength(match.text) < meta.minByteLength
    ) {
      continue;
    }

    // Post-match validation: if the pattern came from
    // a stdnum validator, compact (strip separators)
    // then validate. The candidate regex may capture
    // spaced/dashed variants that validate() rejects
    // without compaction.
    if (meta.validator) {
      const validatorText = meta.validatorInput
        ? meta.validatorInput(match.text)
        : match.text;
      const compacted = meta.validator.compact(validatorText);
      const result = meta.validator.validate(compacted);
      if (!result.valid) {
        continue;
      }
    }

    const entity: Entity = {
      start: match.start,
      end: match.end,
      label: meta.label,
      text: match.text,
      score: meta.score,
      source: DETECTION_SOURCES.REGEX,
    };
    if (meta.sourceDetail) {
      entity.sourceDetail = meta.sourceDetail;
    }
    results.push(entity);
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
    guardPrefixPhrases?: string[];
    guardSuffixPhrases?: string[];
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
const languageMatches = (
  entryLanguage: string,
  selectedLanguages: readonly string[] | undefined,
): boolean => {
  if (selectedLanguages === undefined || selectedLanguages.length === 0) {
    return true;
  }
  const normalizedEntry = entryLanguage.toLowerCase();
  return selectedLanguages.some((language) => {
    const normalized = language.trim().toLowerCase();
    return (
      normalized === normalizedEntry ||
      normalized.split("-").at(0) === normalizedEntry
    );
  });
};

const buildSigningClausePatterns = (
  data: SigningClauseConfig,
  selectedLanguages?: readonly string[],
): string[] => {
  const patterns: string[] = [];

  for (const entry of data.patterns) {
    if (!languageMatches(entry.lang, selectedLanguages)) {
      continue;
    }

    const prepAlt =
      entry.prepositions.length > 0 ? entry.prepositions.join("|") : null;

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

export const SIGNING_CLAUSE_META: Readonly<RegexMeta> = {
  label: "address",
  score: 0.9,
};

let signingPatternPromise: Promise<string[]> | null = null;
let nativeSigningPatternPromise: Promise<string[]> | null = null;

const loadSigningPatterns = async (
  selectedLanguages?: readonly string[],
): Promise<string[]> => {
  const mod = await import("../data/signing-clauses.json");
  const data: SigningClauseConfig = mod.default ?? mod;
  return buildSigningClausePatterns(data, selectedLanguages);
};

const loadNativeSigningPatterns = async (
  selectedLanguages?: readonly string[],
): Promise<string[]> => {
  const mod = await import("../data/signing-clauses.json");
  const data: SigningClauseConfig = mod.default ?? mod;
  return buildSigningClausePatterns(data, selectedLanguages);
};

export const getSigningClausePatterns = (
  selectedLanguages?: readonly string[],
): Promise<string[]> => {
  if (selectedLanguages !== undefined) {
    return loadSigningPatterns(selectedLanguages);
  }
  if (!signingPatternPromise) {
    signingPatternPromise = loadSigningPatterns().catch((err) => {
      signingPatternPromise = null;
      throw err;
    });
  }
  return signingPatternPromise;
};

export const getNativeSigningClausePatterns = (
  selectedLanguages?: readonly string[],
): Promise<string[]> => {
  if (selectedLanguages !== undefined) {
    return loadNativeSigningPatterns(selectedLanguages);
  }
  if (!nativeSigningPatternPromise) {
    nativeSigningPatternPromise = loadNativeSigningPatterns().catch((err) => {
      nativeSigningPatternPromise = null;
      throw err;
    });
  }
  return nativeSigningPatternPromise;
};
