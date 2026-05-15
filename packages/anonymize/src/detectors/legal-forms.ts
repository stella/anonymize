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

const UPPER = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑĄĆĘŁŃŚŹŻ\\u0130";
const LOWER = "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñąćęłńśźż\\u0131";
const CAP_WORD = `(?:[${UPPER}]{2,}|[${UPPER}][${LOWER}${UPPER}]+)`;
// Standalone single uppercase letter — used inside company
// names like "X Holdings I, Inc." or "X Corp." where the
// company token or a Roman-numeral-shaped suffix is one
// character long. The negative lookahead keeps it from
// eating the first letter of a real multi-letter Cap word.
const SINGLE_CAP = `[${UPPER}](?![${LOWER}${UPPER}])`;
// All-caps word: 2+ uppercase letters, no lowercase.
// For company names like "EAGLES BRNO", max 3 words.
const ALLCAP_WORD = `[${UPPER}]{2,}`;
// Horizontal whitespace as understood by DOCX text extraction.
// `regex`/TextSearch does not treat NBSP variants as `\s`, but
// company names often contain them between words and legal forms.
const HSPACE = "(?:[^\\S\\n]|[  ])";
const LEGAL_LIST_BOUNDARY_RE = new RegExp(
  `^[,;]${HSPACE}+(?=\\p{Lu}|(?:\\p{Lu}\\.${HSPACE}?){2,})`,
  "u",
);

const ROMAN_NUMERAL_RE =
  /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

type LeadingClauseTrimConfig = {
  phrases?: readonly string[];
  directPrefixes?: readonly string[];
};

type LeadingClauseTrims = {
  phrases: readonly string[];
  directPrefixes: readonly string[];
};

const EMPTY_LEADING_CLAUSE_TRIMS: LeadingClauseTrims = {
  phrases: [],
  directPrefixes: [],
};

let leadingClauseTrimsCache: LeadingClauseTrims | null = null;
let leadingClauseTrimsPromise: Promise<LeadingClauseTrims> | null = null;

const loadLeadingClauseTrims = async (): Promise<LeadingClauseTrims> => {
  if (leadingClauseTrimsCache) return leadingClauseTrimsCache;
  if (leadingClauseTrimsPromise) return leadingClauseTrimsPromise;
  leadingClauseTrimsPromise = (async () => {
    let data: Record<string, unknown> = {};
    try {
      const mod = await import("../data/legal-form-leading-clauses.json");
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[anonymize] legal-forms: failed to load " +
          "legal-form-leading-clauses.json:",
        err,
      );
    }

    const phrases = new Set<string>();
    const directPrefixes = new Set<string>();
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_") || typeof value !== "object" || value === null) {
        continue;
      }
      const config = value as LeadingClauseTrimConfig;
      for (const phrase of config.phrases ?? []) {
        if (typeof phrase === "string" && phrase.length > 0) {
          phrases.add(phrase);
        }
      }
      for (const prefix of config.directPrefixes ?? []) {
        if (typeof prefix === "string" && prefix.length > 0) {
          directPrefixes.add(prefix);
        }
      }
    }

    const result = {
      phrases: [...phrases],
      directPrefixes: [...directPrefixes],
    };
    leadingClauseTrimsCache = result;
    return result;
  })();
  return leadingClauseTrimsPromise;
};

const getLeadingClauseTrimsSync = (): LeadingClauseTrims =>
  leadingClauseTrimsCache ?? EMPTY_LEADING_CLAUSE_TRIMS;

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
    loadClauseNounHeads(),
    loadConnectorProseHeads(),
    loadStructuralSingleCapPrefixes(),
    loadLeadingClauseTrims(),
  ]);
};

// Suffix anchoring during the role-head trim needs the FULL
// legal-form vocabulary (not just the small `LEGAL_SUFFIXES`
// propagation list). "Vendor owns Acme Corp." has to anchor on
// "Corp." but `LEGAL_SUFFIXES` is Czech-leaning; load the same
// JSON the pattern builder uses and flatten it once.
let allLegalSuffixesCache: readonly string[] | null = null;
let allLegalSuffixesPromise: Promise<readonly string[]> | null = null;
let normalizedLegalBoundarySuffixesCache: ReadonlySet<string> | null = null;
let normalizedInNameLegalFormWordsCache: ReadonlySet<string> | null = null;

const normalizeLegalSuffixToken = (suffix: string): string =>
  suffix.replace(/[.,\s]/g, "");

const isBoundaryLegalSuffixForm = (form: string): boolean => {
  const normalized = normalizeLegalSuffixToken(form);
  if (normalized.length === 0) {
    return false;
  }
  if (LEGAL_SUFFIXES.includes(form)) {
    return true;
  }
  return /[.]/u.test(form) || normalized === normalized.toUpperCase();
};

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
    normalizedLegalBoundarySuffixesCache = new Set(
      out
        .filter(isBoundaryLegalSuffixForm)
        .map(normalizeLegalSuffixToken)
        .filter((suffix) => suffix.length > 0),
    );
    normalizedInNameLegalFormWordsCache = new Set(
      out
        .filter((form) => !isBoundaryLegalSuffixForm(form) && !/\s/u.test(form))
        .map(normalizeLegalSuffixToken)
        .filter((suffix) => suffix.length > 0),
    );
    return out;
  })();
  return allLegalSuffixesPromise;
};

const getAllLegalSuffixesSync = (): readonly string[] =>
  allLegalSuffixesCache ?? LEGAL_SUFFIXES;

const getNormalizedLegalBoundarySuffixesSync = (): ReadonlySet<string> =>
  normalizedLegalBoundarySuffixesCache ??
  new Set(
    LEGAL_SUFFIXES.map(normalizeLegalSuffixToken).filter(
      (suffix) => suffix.length > 0,
    ),
  );

const getNormalizedInNameLegalFormWordsSync = (): ReadonlySet<string> =>
  normalizedInNameLegalFormWordsCache ?? new Set<string>();

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
//
// Sourced from `data/clause-noun-heads.json` (per-language so
// vocabulary stays next to other per-language data). Loaded
// lazily; `warmLegalRoleHeads()` resolves the cache before
// `processLegalFormMatches` runs.
const CLAUSE_NOUN_HEADS_SEED: ReadonlySet<string> = new Set([
  "agreement",
  "contract",
]);

let clauseNounHeadsCache: ReadonlySet<string> | null = null;
let clauseNounHeadsPromise: Promise<ReadonlySet<string>> | null = null;

const loadClauseNounHeads = async (): Promise<ReadonlySet<string>> => {
  if (clauseNounHeadsCache) return clauseNounHeadsCache;
  if (clauseNounHeadsPromise) return clauseNounHeadsPromise;
  clauseNounHeadsPromise = (async () => {
    let data: Record<string, unknown> = {};
    try {
      const mod = await import("../data/clause-noun-heads.json");
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[anonymize] legal-forms: failed to load " +
          "clause-noun-heads.json, falling back to seed list:",
        err,
      );
    }
    const all = new Set<string>(CLAUSE_NOUN_HEADS_SEED);
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(value)) continue;
      for (const noun of value) {
        if (typeof noun !== "string" || noun.length === 0) continue;
        all.add(noun.toLowerCase());
      }
    }
    clauseNounHeadsCache = all;
    return all;
  })();
  return clauseNounHeadsPromise;
};

const getClauseNounHeadsSync = (): ReadonlySet<string> =>
  clauseNounHeadsCache ?? CLAUSE_NOUN_HEADS_SEED;

let connectorProseHeadsCache: ReadonlySet<string> | null = null;
let connectorProseHeadsPromise: Promise<ReadonlySet<string>> | null = null;

const loadConnectorProseHeads = async (): Promise<ReadonlySet<string>> => {
  if (connectorProseHeadsCache) {
    return connectorProseHeadsCache;
  }
  if (connectorProseHeadsPromise) {
    return connectorProseHeadsPromise;
  }

  connectorProseHeadsPromise = (async () => {
    let data: { roles?: unknown } = {};
    try {
      const mod = await import("../data/generic-roles.json");
      const parsed = (mod as { default?: { roles?: unknown } }).default ?? mod;
      data = parsed as { roles?: unknown };
    } catch (err) {
      console.warn(
        "[anonymize] legal-forms: failed to load generic-roles.json:",
        err,
      );
    }

    const all = new Set<string>();
    if (Array.isArray(data.roles)) {
      for (const role of data.roles) {
        if (typeof role === "string" && role.length > 0) {
          all.add(role.toLowerCase());
        }
      }
    }

    connectorProseHeadsCache = all;
    return all;
  })();

  return connectorProseHeadsPromise;
};

const getConnectorProseHeadsSync = (): ReadonlySet<string> =>
  connectorProseHeadsCache ?? new Set<string>();

let structuralSingleCapPrefixesCache: ReadonlySet<string> | null = null;
let structuralSingleCapPrefixesPromise: Promise<ReadonlySet<string>> | null =
  null;

const loadStructuralSingleCapPrefixes = async (): Promise<
  ReadonlySet<string>
> => {
  if (structuralSingleCapPrefixesCache) {
    return structuralSingleCapPrefixesCache;
  }
  if (structuralSingleCapPrefixesPromise) {
    return structuralSingleCapPrefixesPromise;
  }

  structuralSingleCapPrefixesPromise = (async () => {
    let data: Record<string, unknown> = {};
    try {
      const mod = await import("../data/structural-single-cap-prefixes.json");
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[anonymize] legal-forms: failed to load " +
          "structural-single-cap-prefixes.json:",
        err,
      );
    }

    const all = new Set<string>();
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) {
        continue;
      }
      if (!Array.isArray(value)) {
        continue;
      }
      for (const prefix of value) {
        if (typeof prefix !== "string" || prefix.length === 0) {
          continue;
        }
        all.add(prefix.toLowerCase());
      }
    }

    structuralSingleCapPrefixesCache = all;
    return all;
  })();

  return structuralSingleCapPrefixesPromise;
};

const getStructuralSingleCapPrefixesSync = (): ReadonlySet<string> =>
  structuralSingleCapPrefixesCache ?? new Set<string>();

const escapeForRegex = (form: string): string =>
  form
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, `${HSPACE}+`)
    // Use [^\S\n]? (optional horizontal whitespace)
    // instead of \s* to prevent greedy matching across
    // newlines which causes DFA failures in regex-set.
    .replace(/\\\./g, `\\.${HSPACE}?`);

const isShortForm = (form: string): boolean =>
  form.replace(/[.\s]/g, "").length <= 3 && !form.includes(" ");

const buildDottedAbbreviationAlternation = (forms: readonly string[]): string =>
  [
    ...new Set(
      forms
        .filter((form) => /^[\p{Lu}][\p{L}\p{M}]{0,5}\.$/u.test(form))
        .map((form) => form.slice(0, -1))
        .filter((form) => form.length > 0),
    ),
  ]
    .toSorted((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");

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
  const LOWER_CONNECTOR = `${HSPACE}+(?:a|and|und|et|e|y|i)${HSPACE}+(?=[${LOWER}])`;
  const SIMPLE_SEP = `(?:${HSPACE}|[&,.${DASH_INNER}]){1,4}`;
  // Uppercase- or digit-only word for the strict head.
  // Lowercase-starting tokens can only appear in the
  // optional tail below. Single uppercase letters
  // ("I", "X") are accepted so party names like
  // "X Holdings I, Inc." survive the head walk —
  // standalone single-cap heads still need a real cap
  // word continuation or the trailing legal-form suffix
  // to anchor the match.
  const CAP_OR_NUM_WORD = `(?:${CAP_WORD}|${SINGLE_CAP}|\\d{1,4})`;
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
  //
  const dottedAbbreviationAlt = buildDottedAbbreviationAlternation(forms);
  const dottedAbbreviationTail =
    dottedAbbreviationAlt.length > 0
      ? `(?:${SIMPLE_SEP}(?:${dottedAbbreviationAlt})\\.)?`
      : "";
  const head =
    `(?:${CAP_WORD})(?:${SIMPLE_SEP}(?:${CAP_OR_NUM_WORD})){0,10}` +
    dottedAbbreviationTail;
  // Tail allows up to 10 tokens so long state-form names
  // ("Národní agentura pro podporu rozvoje vzdělávání …, z.s.")
  // still match end-to-end. Sentence-fragment over-extension
  // is handled later by the role-head trim, not by tightening
  // this regex.
  const tail =
    `${SIMPLE_SEP}(?:${LOWER_WORD})` +
    `(?:(?:${LOWER_CONNECTOR}|${SIMPLE_SEP})(?:${ANY_WORD_TAIL})){0,10}`;
  const prefix = `(?:${head})(?:${tail})?`;
  const separator = `(?:${HSPACE}+|,${HSPACE}*)`;

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
  // Dedupe case-sensitively so all-caps and title-case
  // spellings of the same form ("Ltda." vs "LTDA.",
  // "Pty Ltd" vs "PTY LTD") both reach the detector
  // regex. The escaped alternatives are matched case-
  // sensitively, so dropping one spelling silently blinds
  // the detector to that casing in real documents.
  const seen = new Set<string>();

  for (const forms of Object.values(data)) {
    for (const form of forms) {
      if (!seen.has(form)) {
        seen.add(form);
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
    if (!seen.has(form)) {
      seen.add(form);
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
  const allcapAlt = allForms
    .toSorted((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");
  const mixedNameSep = `(?:${HSPACE}|[&,.${DASH_INNER}]){1,4}`;

  const capitalizedNoDigitPrefix =
    `(?:${CAP_WORD})` +
    `(?:${mixedNameSep}(?:${CAP_WORD}|${ALLCAP_WORD})){1,8}`;
  patterns.push(
    `${capitalizedNoDigitPrefix}(?:${HSPACE}+|,${HSPACE}*)` +
      `(?:${allcapAlt})(?![${LOWER}])`,
  );

  // Brand acronyms followed by mixed-case place or product
  // words: "IKEA Bratislava, s.r.o.". The generic pattern can
  // over-capture from preceding clause prose before reaching the
  // suffix; this narrower pattern anchors directly on the acronym
  // head so the merge step can keep the precise organization span.
  const allcapMixedPrefix =
    `(?:${ALLCAP_WORD})` +
    `(?:${mixedNameSep}(?:${CAP_WORD}|${ALLCAP_WORD}|\\d{1,4})){1,6}`;
  patterns.push(
    `${allcapMixedPrefix}(?:${HSPACE}+|,${HSPACE}*)` +
      `(?:${allcapAlt})(?![${LOWER}])`,
  );

  // SEC/EDGAR HTML often wraps terminal legal forms onto
  // the next physical line after a dotted business
  // designator: "Goldman Sachs & Co.\nLLC". Keep the
  // newline allowance this narrow so ordinary legal-form
  // matching still cannot sweep across headings or
  // paragraph boundaries.
  const dottedLineWrapPrefix =
    `(?:${CAP_WORD})` +
    `(?:${mixedNameSep}(?:${CAP_WORD}|${ALLCAP_WORD})){1,8}` +
    `\\.${HSPACE}*\\n${HSPACE}*`;
  patterns.push(`${dottedLineWrapPrefix}(?:${allcapAlt})(?![${LOWER}])`);

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
    `(?:(?:${HSPACE}|[&,.${DASH_INNER}]){1,4}(?:${ALLCAP_WORD})){0,2}`;
  patterns.push(
    `${allcapPrefix}(?:${HSPACE}+|,${HSPACE}*)` +
      `(?:${allcapAlt})(?![${LOWER}])`,
  );

  // Single-letter company name immediately followed by a
  // legal-form suffix ("X Corp.", "X Inc."). Kept on its
  // own narrow pattern with a tight horizontal-space-only
  // separator so digits or stray Cap letters between the
  // initial and the suffix do not anchor a sweep — the
  // generic head pattern above stays at 2+ characters to
  // avoid lighting up on Czech postcode rows like
  // "PSČ 466 01\tPS" where a single uppercase letter sits
  // far ahead of the suffix.
  patterns.push(
    `(?:^|(?<=[^${UPPER}${LOWER}\\p{N}]))[${UPPER}](?:${HSPACE}+|,${HSPACE}*)` +
      `(?:${allcapAlt})(?![${UPPER}${LOWER}\\p{N}])`,
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
const BARE_SINGLE_CAP_LEGAL_FORM_RE = new RegExp(
  `^[${UPPER}](?:${HSPACE}+|,${HSPACE}*)`,
  "u",
);
const STRUCTURAL_SINGLE_CAP_RE = new RegExp(
  `^([\\p{L}\\p{M}]+)${HSPACE}+[${UPPER}](?:[.${DASH_INNER}]?\\d{1,3})?(?:${HSPACE}+|,${HSPACE}*)`,
  "u",
);
const isStructuralSingleCapMatch = (text: string): boolean => {
  const first = STRUCTURAL_SINGLE_CAP_RE.exec(text)?.[1];
  return (
    first !== undefined &&
    getStructuralSingleCapPrefixesSync().has(first.toLowerCase())
  );
};

const findLastSuffixSeparator = (text: string): number =>
  Math.max(
    text.lastIndexOf(" "),
    text.lastIndexOf("\t"),
    text.lastIndexOf(" "),
    text.lastIndexOf(" "),
    text.lastIndexOf(","),
  );

const stripDocxSpaces = (text: string): string => text.replace(/[  ]/g, "");

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

const hasSingleCapPrefixBefore = (
  fullText: string,
  matchStart: number,
): boolean => {
  const prev = findWordBefore(fullText, matchStart);
  return (
    prev !== null && prev.word.length === 1 && UPPER_LETTER_RE.test(prev.word)
  );
};

const isBareSingleCapStructuralInnerMatch = (
  fullText: string,
  matchStart: number,
  text: string,
): boolean => {
  if (!BARE_SINGLE_CAP_LEGAL_FORM_RE.test(text)) {
    return false;
  }

  const prev = findWordBefore(fullText, matchStart);
  return (
    prev !== null &&
    getStructuralSingleCapPrefixesSync().has(prev.word.toLowerCase())
  );
};

const trimEmbeddedLegalFormListPrefix = (
  entityStart: number,
  entityText: string,
): { entityStart: number; entityText: string } => {
  let cut = -1;

  for (const suffix of getAllLegalSuffixesSync()) {
    const suffixClean = suffix.replace(/[.,\s]/g, "");
    if (suffixClean.length > 0 && ROMAN_NUMERAL_RE.test(suffixClean)) {
      continue;
    }

    let fromIndex = 0;
    while (fromIndex < entityText.length) {
      const suffixStart = entityText.indexOf(suffix, fromIndex);
      if (suffixStart === -1) {
        break;
      }
      fromIndex = suffixStart + suffix.length;

      const suffixEnd = suffixStart + suffix.length;
      if (suffixEnd >= entityText.length - 1) {
        continue;
      }

      const afterSuffix = entityText.slice(suffixEnd);
      const boundary = /^,\s+(?=\p{Lu})/u.exec(afterSuffix);
      if (boundary === null) {
        continue;
      }

      const nextStart = suffixEnd + boundary[0].length;
      const remainder = entityText.slice(nextStart);
      if (!getAllLegalSuffixesSync().some((form) => remainder.endsWith(form))) {
        continue;
      }

      cut = Math.max(cut, nextStart);
    }
  }

  if (cut <= 0) {
    return { entityStart, entityText };
  }

  return {
    entityStart: entityStart + cut,
    entityText: entityText.slice(cut),
  };
};

const splitEmbeddedLegalFormList = (
  entityStart: number,
  entityText: string,
): { entityStart: number; entityText: string }[] => {
  const cuts = [0];

  for (const suffix of getAllLegalSuffixesSync()) {
    const suffixClean = suffix.replace(/[.,\s]/g, "");
    if (suffixClean.length > 0 && ROMAN_NUMERAL_RE.test(suffixClean)) {
      continue;
    }

    let fromIndex = 0;
    while (fromIndex < entityText.length) {
      const suffixStart = entityText.indexOf(suffix, fromIndex);
      if (suffixStart === -1) {
        break;
      }
      fromIndex = suffixStart + suffix.length;

      const suffixEnd = suffixStart + suffix.length;
      if (suffixEnd >= entityText.length - 1) {
        continue;
      }

      const afterSuffix = entityText.slice(suffixEnd);
      const boundary = LEGAL_LIST_BOUNDARY_RE.exec(afterSuffix);
      if (boundary === null) {
        continue;
      }

      // Cut at every list boundary that immediately
      // follows a legal-form suffix. The left segment
      // is a complete org; the right segment is filtered
      // below by the per-segment suffix gate. Previously
      // we required the *right* side to end in a suffix
      // too, which let lists like "Morgan Stanley & Co.
      // LLC, Bank of America" be captured as one org
      // because the trailing "Bank of America" lacks a
      // suffix.
      const nextStart = suffixEnd + boundary[0].length;
      cuts.push(nextStart);
    }
  }

  const uniqueCuts = [...new Set(cuts)].toSorted((a, b) => a - b);
  if (uniqueCuts.length === 1) {
    return [{ entityStart, entityText }];
  }

  const segments: { entityStart: number; entityText: string }[] = [];
  for (let index = 0; index < uniqueCuts.length; index++) {
    const start = uniqueCuts[index];
    const end = uniqueCuts[index + 1] ?? entityText.length;
    if (start === undefined) {
      continue;
    }
    const segmentText = entityText.slice(start, end).replace(/[,\s;]+$/u, "");
    if (segmentText.length === 0) {
      continue;
    }
    // Skip the segment unless it ends with a recognised
    // legal-form suffix. This drops the right-hand side
    // of a list-cut when only the left side carries a
    // suffix (see split note above), letting other
    // detectors claim the remainder if appropriate.
    const endsWithSuffix = getAllLegalSuffixesSync().some((form) =>
      segmentText.endsWith(form),
    );
    if (!endsWithSuffix) {
      continue;
    }
    segments.push({
      entityStart: entityStart + start,
      entityText: segmentText,
    });
  }

  return segments;
};

const hasDisallowedLineBreak = (text: string): boolean => {
  for (const match of text.matchAll(/\n/gu)) {
    const index = match.index;
    if (index === undefined) {
      continue;
    }
    const before = text.slice(0, index);
    const after = text.slice(index + 1);
    const dottedDesignatorBefore = /\.[^\S\n]*$/u.test(before);
    const legalSuffixAfter =
      /^[^\S\n]*(?:\p{Lu}\.[^\S\n]?){1,}\p{Lu}?\.?$/u.test(after);
    const allCapsSuffixAfter = /^[^\S\n]*\p{Lu}{2,}\.?$/u.test(after);
    if (!dottedDesignatorBefore || (!legalSuffixAfter && !allCapsSuffixAfter)) {
      return true;
    }
  }
  return false;
};

const hasMiddleInitialBefore = (fullText: string, pos: number): boolean => {
  const previousWord = findWordBefore(fullText, pos);
  if (!previousWord) {
    return false;
  }

  let scan = previousWord.start - 1;
  while (scan >= 0 && (fullText[scan] === " " || fullText[scan] === "\t")) {
    scan--;
  }

  return (
    scan >= 1 &&
    fullText[scan] === "." &&
    UPPER_LETTER_RE.test(fullText[scan - 1] ?? "")
  );
};

/**
 * Count consecutive uppercase-starting words immediately
 * before `pos`. Stops at the first non-upper word or at
 * text/line start. Used to disambiguate sentence prose
 * ("<First> <Last> and <ORG>", "<Defined-Term> and
 * <ORG>") from multi-word organisation names that span
 * an "and" connector ("UniCredit Bank Czech Republic and
 * Slovakia, a.s.").
 *
 * When `crossInNamePreps` is true, the walk also steps
 * over in-name lowercase prepositions ("of", "the") as
 * long as they sit between two upper words. This lets
 * the suffix-mode "and"-crossing logic see through
 * "<Trust ← and ← America ← of ← Bank>" and emit one
 * full organisation span.
 */
const countUpperWordsBefore = (
  fullText: string,
  pos: number,
  crossInNamePreps = false,
): number => {
  let count = 0;
  let scan = pos;
  while (scan > 0) {
    const found = findWordBefore(fullText, scan);
    if (found) {
      if (UPPER_LETTER_RE.test(found.word)) {
        count++;
        scan = found.start;
        continue;
      }
      if (crossInNamePreps && IN_NAME_PREPOSITION_RE.test(found.word)) {
        // Only cross the preposition when it sits between
        // two uppercase words — never when it sentence-
        // starts the phrase.
        const prev = findWordBefore(fullText, found.start);
        if (!prev) break;
        if (!UPPER_LETTER_RE.test(prev.word)) break;
        scan = found.start;
        continue;
      }
      break;
    }

    let p = scan - 1;
    while (p >= 0 && (fullText[p] === " " || fullText[p] === "\t")) {
      p--;
    }
    if (
      p >= 1 &&
      fullText[p] === "." &&
      UPPER_LETTER_RE.test(fullText[p - 1] ?? "")
    ) {
      count++;
      scan = p - 1;
      continue;
    }
    break;
  }
  return count;
};

/**
 * True when `word` is a recognized legal-form suffix
 * (case-sensitive against the legal-forms vocabulary).
 * Used when deciding whether to cross an "and" connector
 * during backward extension — if the word immediately
 * preceding the connector is itself a legal-form suffix,
 * the "and" sits between two organisation names rather
 * than inside one ("Morgan Securities LLC and Allen &
 * Company LLC"), so the walk must stop there.
 */
const isKnownLegalFormSuffix = (word: string): boolean => {
  if (word.length === 0) {
    return false;
  }
  return getNormalizedLegalBoundarySuffixesSync().has(word);
};

const isInNameLegalFormWord = (word: string): boolean => {
  if (word.length === 0) {
    return false;
  }
  return getNormalizedInNameLegalFormWordsSync().has(word);
};

/**
 * If `pos` is immediately preceded (modulo horizontal
 * whitespace) by an initial-dot run like `J.P.`, `U.S.`,
 * or `N.A.`, return the position where the initial run
 * starts. Otherwise return `pos` unchanged. The run must
 * be word-bounded on the left so we never absorb a stray
 * sentence-ending dot.
 */
const skipInitialsBackward = (fullText: string, pos: number): number => {
  // Skip horizontal whitespace only — initials must sit
  // on the same line as the rest of the org name.
  let scan = pos - 1;
  while (scan >= 0) {
    const ch = fullText.charAt(scan);
    if (ch === "\n" || !/\s/.test(ch)) break;
    scan--;
  }
  if (scan < 0 || fullText.charAt(scan) !== ".") return pos;
  // Match one or more `<Upper>.` tokens at the right
  // edge of `fullText[0..scan+1]`. Allows optional
  // single horizontal space between tokens
  // ("J. P. Morgan" as well as "J.P. Morgan").
  const scanLimit = Math.max(0, scan + 1 - 100);
  const head = fullText.slice(scanLimit, scan + 1);
  const initialsRe = /(?:\p{Lu}\.[^\S\n]?){2,}$/u;
  const match = initialsRe.exec(head);
  if (match === null) return pos;
  const start = scanLimit + match.index;
  if (start > 0) {
    const prevCh = fullText.charAt(start - 1);
    if (/[\p{L}\p{M}\p{N}]/u.test(prevCh)) return pos;
  }
  return start;
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
      if (AND_TYPE_CONNECTOR_RE.test(word)) {
        // Decide whether the "and" sits inside one
        // organisation name or between two sentence
        // tokens. Heuristics, applied in order:
        //
        // 1. If the word immediately before the "and"
        //    is itself a known legal-form suffix
        //    ("Morgan Securities LLC and Allen &
        //    Company LLC", "Apple, Inc. and Microsoft
        //    Corp."), the "and" separates two orgs —
        //    break regardless of mode.
        // 2. A single uppercase word before the "and"
        //    is almost always a defined-term clause
        //    noun ("the Company and Barclays Bank
        //    PLC", "Company and Bank of America,
        //    N.A.") rather than part of the org
        //    name — break regardless of mode.
        // 3. Outside suffix mode, also break on two
        //    upper words (typical person-name
        //    pattern: "Paul Newman and Apple, Inc.").
        //    Three or more upper words signals a
        //    real multi-word organisation name
        //    ("UniCredit Bank Czech Republic and
        //    Slovakia, a.s."), so the walk crosses.
        // 4. In suffix mode the regex already
        //    captured a leading legal-form suffix
        //    word ("…and Company, Inc."), so any
        //    multi-word prefix should flow through.
        const prev = findWordBefore(fullText, wordStart);
        if (!prev) break;
        if (!UPPER_LETTER_RE.test(prev.word)) break;
        if (isKnownLegalFormSuffix(prev.word)) break;
        const upperWordsBefore = countUpperWordsBefore(
          fullText,
          wordStart,
          suffixMode,
        );
        const middleInitialBefore = hasMiddleInitialBefore(fullText, wordStart);
        if (
          upperWordsBefore <= 1 &&
          (getClauseNounHeadsSync().has(prev.word.toLowerCase()) ||
            getConnectorProseHeadsSync().has(prev.word.toLowerCase()))
        ) {
          break;
        }
        const personNameBoundary = suffixMode
          ? middleInitialBefore &&
            hasSingleCapPrefixBefore(fullText, matchStart)
          : (upperWordsBefore === 2 && !isInNameLegalFormWord(prev.word)) ||
            middleInitialBefore;
        if (personNameBoundary) {
          break;
        }
        pos = prev.start;
      } else {
        // Non-"and" connector (`&`, `e`, `y`, `i`,
        // standalone `a`). Cross when there's a valid
        // uppercase-starting word before it.
        const prev = findWordBefore(fullText, wordStart);
        if (!prev) break;
        const prevIsUpper = UPPER_LETTER_RE.test(prev.word);
        if (!prevIsUpper) break;
        pos = prev.start;
      }
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

  // After the word walk finishes, absorb any leading
  // initial-dot run that the letter-based word scan
  // skipped over ("J.P. Morgan Securities LLC",
  // "U.S. Bancorp Inc."). The walk above stops at the
  // dot because `findWordBefore` only consumes letters,
  // so without this step the entity start lands on the
  // first non-initial word.
  pos = skipInitialsBackward(fullText, pos);

  return pos;
};

const trimLeadingClause = (text: string): { offset: number; text: string } => {
  let cut = -1;
  const trims = getLeadingClauseTrimsSync();
  const phraseAlternation = trims.phrases.map(escapeForRegex).join("|");
  if (phraseAlternation.length > 0) {
    const phraseRe = new RegExp(
      `(?:^|\\s)(?:${phraseAlternation})${HSPACE}+`,
      "giu",
    );
    for (const match of text.matchAll(phraseRe)) {
      cut = Math.max(cut, match.index + match[0].length);
    }
  }

  const directPrefixAlternation = trims.directPrefixes
    .map(escapeForRegex)
    .join("|");
  // "among" / "amongst" / "between" can legitimately
  // appear inside a title-case org name ("Food For
  // Thought Among Friends LLC", "The Space In Between
  // LLC"). For those prefixes we require a clause
  // separator (comma) immediately before the prefix,
  // which is the structural signal that distinguishes
  // a connector ("Investment Agreement, dated as of
  // March 9, 2020, among Twitter, Inc.") from a name
  // component.
  const COMMA_GATED_DIRECT_PREFIXES: ReadonlySet<string> = new Set([
    "among",
    "amongst",
    "between",
  ]);
  if (directPrefixAlternation.length > 0) {
    const directPrefixRe = new RegExp(
      `\\b(?:${directPrefixAlternation})${HSPACE}+(?=\\p{Lu})`,
      "giu",
    );
    for (const match of text.matchAll(directPrefixRe)) {
      const matchedPrefix = match[0].trim().toLowerCase();
      const before = text.slice(0, match.index);
      if (
        COMMA_GATED_DIRECT_PREFIXES.has(matchedPrefix) &&
        !/,\s*$/u.test(before)
      ) {
        continue;
      }
      const words = before.match(/\p{L}[\p{L}\p{M}]*/gu) ?? [];
      const hasProsePrefix =
        words.length >= 3 && words.some((word) => /\p{Ll}/u.test(word));
      if (hasProsePrefix) {
        cut = Math.max(cut, match.index + match[0].length);
      }
    }
  }
  for (const match of text.matchAll(/,/gu)) {
    const comma = match.index;
    if (comma === undefined) {
      continue;
    }
    const before = text.slice(0, comma);
    if (!/\d/u.test(before)) {
      continue;
    }
    const after = text.slice(comma + 1);
    const leadingWs = after.match(/^\s*/u)?.[0].length ?? 0;
    const candidate = after.slice(leadingWs);
    const upperWords = candidate.match(/\p{Lu}[\p{L}\p{M}\p{N}]*/gu) ?? [];
    if (upperWords.length >= 3) {
      cut = Math.max(cut, comma + 1 + leadingWs);
    }
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
    // Match the first token. Hyphenated forms ("Sous-traitant",
    // "co-contractant") are valid role heads in some languages,
    // so consume any internal `-letter` runs alongside the
    // letter-only head. The lookup uses the full hyphenated form
    // first, then falls back to just the leading letter run when
    // the role-head set lists only the bare prefix.
    const firstWordMatch = /^[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/u.exec(text);
    let processedStart = match.start;
    let processedText = text;
    if (
      isStructuralSingleCapMatch(processedText) ||
      (fullText !== undefined &&
        isBareSingleCapStructuralInnerMatch(fullText, match.start, text))
    ) {
      continue;
    }
    // True when the role-head trim slices the match. The
    // subsequent extendBackward step is suppressed in that case
    // — extending back would re-absorb the very prose the trim
    // just removed (e.g. "Vendor grants Licensee Acme Inc." →
    // trim to "Acme Inc." → extendBackward walks back across
    // "Licensee" again and emits "Licensee Acme Inc.").
    let trimmed = false;
    const firstWordText = firstWordMatch?.[0] ?? "";
    const firstWordLeading = /^[\p{L}\p{M}]+/u.exec(firstWordText)?.[0] ?? "";
    const isRoleHead =
      firstWordMatch !== null &&
      (roleHeads.has(firstWordText.toLowerCase()) ||
        (firstWordLeading.length > 0 &&
          roleHeads.has(firstWordLeading.toLowerCase())));
    if (isRoleHead) {
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
          const clauseNouns = getClauseNounHeadsSync();
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
            if (roleHeads.has(lc) || clauseNouns.has(lc)) {
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

    if (processedText.includes("\n") && hasDisallowedLineBreak(processedText)) {
      continue;
    }

    // Extend backward through connectors if fullText
    // is available (captures "Be a Future" from just
    // "Future s.r.o.")
    let entityStart = processedStart;
    let entityText = processedText;
    if (fullText && !trimmed) {
      const shouldExtendBackward =
        !BARE_SINGLE_CAP_LEGAL_FORM_RE.test(processedText);
      const extended = shouldExtendBackward
        ? extendBackward(fullText, processedStart)
        : processedStart;
      if (extended < processedStart) {
        entityStart = extended;
        entityText = fullText
          .slice(extended, processedStart + processedText.length)
          .trimEnd();
      }
    }

    for (const segment of splitEmbeddedLegalFormList(entityStart, entityText)) {
      entityStart = segment.entityStart;
      entityText = segment.entityText;

      const listTrim = trimEmbeddedLegalFormListPrefix(entityStart, entityText);
      entityStart = listTrim.entityStart;
      entityText = listTrim.entityText;

      const clauseTrim = trimLeadingClause(entityText);
      if (clauseTrim.offset > 0) {
        entityStart += clauseTrim.offset;
        entityText = clauseTrim.text;
      }

      if (entityText.includes("\n") && hasDisallowedLineBreak(entityText)) {
        continue;
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
      const lastSuffixSeparator = findLastSuffixSeparator(entityText);
      const rawSuffix =
        lastSuffixSeparator !== -1
          ? entityText.slice(lastSuffixSeparator + 1)
          : "";
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
          stripDocxSpaces(
            entityText.slice(
              0,
              lastSuffixSeparator !== -1
                ? lastSuffixSeparator
                : entityText.length,
            ),
          ),
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
  }

  return results;
};
