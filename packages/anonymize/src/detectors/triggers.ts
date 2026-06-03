import type { Match } from "@stll/text-search";
import { br } from "@stll/stdnum";
import type { Validator } from "@stll/stdnum";

import { DETECTION_SOURCES } from "../types";
import type {
  CompiledValidation,
  Entity,
  TriggerGroupConfig,
  TriggerRule,
  TriggerValidation,
  ValidIdValidator,
} from "../types";
import { POST_NOMINALS } from "../config/titles";
import { getKnownLegalSuffixes } from "./legal-forms";
import { loadLanguageConfigs } from "../util/lang-loader";
import { DASH } from "../util/char-groups";

const VALID_ID_VALIDATORS: Record<ValidIdValidator, Validator> = {
  "br.cpf": br.cpf,
  "br.cnpj": br.cnpj,
};

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;
const LETTER_RE = /\p{L}/u;
/**
 * Decimal-comma pattern: comma followed by digit or
 * dash notation ("0,05%", "1.529,50 Kč", "98.000,- Kč").
 */
const DECIMAL_COMMA_RE = new RegExp(`^,(?:\\d|${DASH}{1,2})`);

/**
 * Post-nominal degree regex. When a comma-stop is
 * followed by a known post-nominal (Ph.D., CSc., MBA
 * etc.), skip the comma and degree, then continue.
 */
const POST_NOMINAL_RE = new RegExp(
  `^,\\s*(?:${POST_NOMINALS.toSorted((a, b) => b.length - a.length)
    .map((d) =>
      d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.\\s*"),
    )
    .join("|")})\\.?`,
  "i",
);

// Definitive legal form suffixes (case-sensitive).
// When a person-labeled trigger captures text containing
// one of these, the entity is reclassified as
// "organization". No "i" flag: short uppercase-only
// forms (SE, SA, AG) must NOT match Czech/Slovak
// reflexive pronouns "se", "sa" which appear in
// person-trigger captures like
// "Ing. Jan Novák, se sídlem...".
//
let cachedLegalFormCheckSource: readonly string[] | null = null;
let cachedLegalFormCheckForms: readonly string[] = [];
const LEGAL_FORM_ALNUM_RE = /[\p{L}\p{N}]/u;
const LETTER_ONLY_LEGAL_FORM_RE = /^[\p{L}\p{M}]+$/u;

const getLegalFormCheckForms = (): readonly string[] => {
  const source = getKnownLegalSuffixes();
  if (cachedLegalFormCheckSource !== source) {
    cachedLegalFormCheckSource = source;
    cachedLegalFormCheckForms = source;
  }
  return cachedLegalFormCheckForms;
};

const hasKnownLegalFormSuffix = (text: string): boolean => {
  for (const form of getLegalFormCheckForms()) {
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const start = text.indexOf(form, fromIndex);
      if (start === -1) {
        break;
      }
      const end = start + form.length;
      fromIndex = start + 1;

      // Dot-free letter-only forms get Unicode-aware word
      // boundaries so short uppercase forms ("SE", "AG") and
      // longer single-word forms ("Branch", "Limited") don't
      // match as substrings of unrelated tokens. Forms with
      // punctuation already terminate naturally.
      if (!LETTER_ONLY_LEGAL_FORM_RE.test(form)) {
        return true;
      }
      if (
        !LEGAL_FORM_ALNUM_RE.test(text[start - 1] ?? "") &&
        !LEGAL_FORM_ALNUM_RE.test(text[end] ?? "")
      ) {
        return true;
      }
    }
  }
  return false;
};

// ── Validation compilation ─────────────────────────

const compileValidations = (
  validations: TriggerValidation[],
): CompiledValidation[] =>
  validations.map((v): CompiledValidation => {
    switch (v.type) {
      case "starts-uppercase":
        return {
          type: "starts-uppercase",
          re: /^\p{Lu}/u,
        };
      case "min-length":
        return { type: "min-length", min: v.min };
      case "max-length":
        return { type: "max-length", max: v.max };
      case "no-digits":
        return { type: "no-digits", re: /\d/ };
      case "has-digits":
        return { type: "has-digits", re: /\d/ };
      case "matches-pattern":
        return {
          type: "matches-pattern",
          // Strip g/y flags: the compiled regex is shared
          // across all rules in the group and must be
          // stateless (no lastIndex advancement).
          re: new RegExp(v.pattern, (v.flags ?? "").replace(/[gy]/g, "")),
        };
      case "valid-id": {
        const validator = VALID_ID_VALIDATORS[v.validator];
        if (!validator) {
          throw new Error(
            `Unknown valid-id validator: ${JSON.stringify(v.validator)}`,
          );
        }
        return {
          type: "valid-id",
          check: (value) => {
            // stdnum validators expect compact digits only;
            // strip formatting (spaces, dots, dashes,
            // slashes) so dotted/spaced IDs still validate.
            const compact = value.replace(/[\s.\-/]/g, "");
            return validator.validate(compact).valid;
          },
        };
      }
      default: {
        // TriggerValidation is a public export; custom
        // configs may bypass the build-time validator.
        const _exhaustive: never = v;
        throw new Error(
          `Unknown validation type: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });

const applyValidations = (
  text: string,
  validations: CompiledValidation[],
): boolean => {
  for (const v of validations) {
    switch (v.type) {
      case "starts-uppercase":
        if (!v.re.test(text)) return false;
        break;
      case "min-length":
        if (text.length < v.min) return false;
        break;
      case "max-length":
        if (text.length > v.max) return false;
        break;
      case "no-digits":
        if (v.re.test(text)) return false;
        break;
      case "has-digits":
        if (!v.re.test(text)) return false;
        break;
      case "matches-pattern":
        if (!v.re.test(text)) return false;
        break;
      case "valid-id":
        if (!v.check(text)) return false;
        break;
      default: {
        const _exhaustive: never = v;
        throw new Error(
          `Unknown compiled validation type: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }
  return true;
};

// ── Trigger expansion ──────────────────────────────

const expandTriggerGroups = (groups: TriggerGroupConfig[]): TriggerRule[] => {
  const rules: TriggerRule[] = [];
  for (const group of groups) {
    const extensions = group.extensions ?? [];
    const compiled = compileValidations(group.validations ?? []);

    // Generate trigger variants from the original
    // trigger strings. Extensions are applied once to
    // the base set only (not combinatorially); e.g.,
    // ["add-colon", "normalize-spaces"] produces
    // "trigger:", "trigger\u00A0", but NOT
    // "trigger\u00A0:". This is intentional to avoid
    // exponential variant growth.
    const allTriggers = new Set(group.triggers);
    for (const trigger of group.triggers) {
      if (extensions.includes("add-colon") && !trigger.endsWith(":"))
        allTriggers.add(`${trigger}:`);
      if (extensions.includes("add-trailing-space") && !trigger.endsWith(" "))
        allTriggers.add(`${trigger} `);
      if (
        extensions.includes("add-colon-space") &&
        !trigger.endsWith(": ") &&
        !trigger.endsWith(":")
      )
        allTriggers.add(`${trigger}: `);
      if (extensions.includes("normalize-spaces")) {
        if (trigger.includes(" ")) {
          allTriggers.add(trigger.replace(/ /g, "\u00A0"));
        }
      }
    }

    const includeTrigger = group.includeTrigger ?? false;

    for (const trigger of allTriggers) {
      rules.push({
        trigger,
        label: group.label,
        strategy: group.strategy,
        validations: compiled,
        includeTrigger,
      });
    }
  }
  return rules;
};

// ── Pattern builder for unified search ──────────────

type TriggerPatterns = {
  patterns: string[];
  rules: TriggerRule[];
};

let triggerPatternsPromise: Promise<TriggerPatterns> | null = null;

/**
 * Build trigger patterns and rules from data configs.
 * Returns string[] for the unified TextSearch
 * builder and the parallel rules array.
 */
const loadTriggerPatterns = async (): Promise<TriggerPatterns> => {
  const rules: TriggerRule[] = [];

  const allGroups = await loadLanguageConfigs<readonly TriggerGroupConfig[]>(
    "triggers",
    (mod) => {
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      const m = mod as {
        default?: readonly TriggerGroupConfig[];
      };
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      return (m.default ?? mod) as readonly TriggerGroupConfig[];
    },
  );
  for (const groups of allGroups) {
    if (!Array.isArray(groups)) {
      console.warn(
        "[anonymize] triggers: unexpected " + "config shape, skipping",
      );
      continue;
    }
    rules.push(...expandTriggerGroups(groups as TriggerGroupConfig[]));
  }

  // Load global triggers (language-agnostic)
  try {
    const globalMod = await import("../data/triggers.global.json");
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
    const globalGroups = ((globalMod as { default?: unknown }).default ??
      globalMod) as TriggerGroupConfig[];
    if (Array.isArray(globalGroups)) {
      rules.push(...expandTriggerGroups(globalGroups));
    }
  } catch (err) {
    // Only suppress "module not found"; re-throw
    // other errors (JSON parse, etc.).
    if (
      !(err instanceof Error) ||
      !err.message.includes("Cannot find module")
    ) {
      throw err;
    }
  }

  // Load year-words from JSON dictionary and create
  // date triggers: "rok 2022" → date entity.
  try {
    const yearMod = await import("../data/year-words.json");
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON
    const data = ((yearMod as { default?: unknown }).default ??
      yearMod) as Record<string, string | string[]>;
    const seen = new Set<string>();
    const yearValidation = compileValidations([
      {
        type: "matches-pattern",
        pattern: "^(?:19|20)\\d{2}\\.?$",
      },
    ]);
    for (const [key, words] of Object.entries(data)) {
      if (key.startsWith("_") || !Array.isArray(words)) {
        continue;
      }
      for (const word of words) {
        const lc = word.toLowerCase();
        if (seen.has(lc)) continue;
        seen.add(lc);
        rules.push({
          trigger: word,
          label: "date",
          strategy: { type: "n-words", count: 1 },
          validations: yearValidation,
          includeTrigger: false,
        });
      }
    }
  } catch {
    // year-words.json not available — skip
  }

  // Warn about cross-group trigger duplicates.
  // Duplicates cause redundant AC matches but are
  // not fatal (mergeAndDedup handles overlap).
  const seen = new Map<string, { label: string; strategy: string }>();
  for (const rule of rules) {
    const key = rule.trigger.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      const labelDiff = prev.label !== rule.label;
      const stratDiff = prev.strategy !== rule.strategy.type;
      if (labelDiff || stratDiff) {
        console.warn(
          `[anonymize] duplicate trigger` +
            ` "${rule.trigger}":` +
            (labelDiff
              ? ` labels "${prev.label}" vs` + ` "${rule.label}"`
              : "") +
            (stratDiff
              ? ` strategies "${prev.strategy}" vs` + ` "${rule.strategy.type}"`
              : ""),
        );
      }
    }
    seen.set(key, {
      label: rule.label,
      strategy: rule.strategy.type,
    });
  }

  // Build patterns from lowercased trigger strings.
  // rules[i] corresponds to patterns[i].
  // Plain lowercased strings — the unified builder
  // sets caseInsensitive globally on the AC.
  const patterns: string[] = rules.map((r) => r.trigger.toLowerCase());

  // Warm the address stop-keywords cache so the
  // synchronous `extractValue` (address strategy) can
  // read it without an async hop.
  await loadAddressStopKeywords();

  return { patterns, rules };
};

export const buildTriggerPatterns = async (): Promise<TriggerPatterns> => {
  triggerPatternsPromise ??= loadTriggerPatterns();
  return triggerPatternsPromise;
};

// ── Value extraction ────────────────────────────────

const LEADING_PUNCT = /^[„""»«'"()\s]+/;
const TRAILING_PUNCT = /[""»«'"()\s]+$/;

const stripQuotes = (value: {
  start: number;
  end: number;
  text: string;
}): {
  start: number;
  end: number;
  text: string;
} | null => {
  const leadingMatch = LEADING_PUNCT.exec(value.text);
  const leadingLen = leadingMatch ? leadingMatch[0].length : 0;
  const stripped = value.text.slice(leadingLen).replace(TRAILING_PUNCT, "");
  if (stripped.length === 0) {
    return null;
  }
  return {
    start: value.start + leadingLen,
    end: value.start + leadingLen + stripped.length,
    text: stripped,
  };
};

/**
 * Hard stop characters for to-next-comma scanning. A closing
 * parenthesis or closing bracket terminates a clause just like
 * an opening one: `State of New York or any other jurisdiction)`
 * is the tail of a parenthesised insertion, not the start of a
 * larger phrase that should be absorbed into a jurisdiction span.
 */
const COMMA_STOP_CHARS = new Set(["\n", "(", ")", "[", "]", "\t", ";"]);

/**
 * Sentence-terminator detection: a period that genuinely ends
 * one clause and starts another. Used by `to-next-comma` so
 * governing-law clauses ("…State of New York. SECTION 2…")
 * don't sweep across the period.
 *
 * Three positive signals (any one terminates):
 *   1. Long lowercase tail before the dot (>= 5 letters) —
 *      catches "…construction. SECTION 2…", "…vykonává.".
 *   2. Currency/amount tail (zł, Kč, USD, €) — catches
 *      "…w kwocie 1000 zł. Termin płatności…".
 *   3. Proper-noun head: a capitalized word of >= 4 letters
 *      ending in lowercase, with no internal uppercase, AND
 *      a substantial next clause (Capital + >= 2 lowercase).
 *      Catches short city names that the lowercase-tail rule
 *      misses: "…z siedzibą w Łódź. Kapitał zakładowy…",
 *      "…seat in Brno. Section 2…".
 *
 * The rule must NOT fire on:
 *   - title abbreviations: "Mr.", "Mrs.", "Dr.", "Hon.",
 *     "Sr.", "Jr." (head <= 3 chars or insufficient Ll tail)
 *   - degree abbreviations: "Ph.D.", "RNDr.", "MUDr.",
 *     "Ing." (internal periods or internal uppercase block
 *      the proper-noun pattern)
 *   - street-type abbreviations: "Ste.", "Ave.", "Inc.",
 *     "ul.", "al.", "nábř." (lowercase initials or
 *     insufficient Ll tail)
 *   - small-word lowercase abbreviations: "prof.", "inż.",
 *     "hab." (no leading uppercase, so the proper-noun rule
 *     can't fire)
 */
const NEXT_IS_SENTENCE_START_RE = /^\.(?:\s+\p{Lu}|\s*$)/u;
const SENTENCE_TAIL_RE = /\p{Ll}{5,}$/u;
/**
 * Proper-noun tail: capital letter + >= 3 lowercase letters,
 * preceded by a non-letter and non-period (so we don't slice
 * into the middle of an acronym or a multi-dot abbreviation).
 * The 4-character minimum excludes 2–3-char titles ("Mr",
 * "Mrs", "Dr", "Inc", "Ste"); the all-lowercase tail
 * excludes mixed-case degrees ("RNDr", "MUDr").
 */
const PROPER_NOUN_HEAD_RE = /(?:^|[^\p{L}.])\p{Lu}\p{Ll}{3,}$/u;
/**
 * Next clause begins with a real word: capital + >= 2
 * lowercase letters. Filters cases where a capitalized
 * abbreviation (e.g., "Smith Inc.") follows a proper noun,
 * which would otherwise look sentence-like.
 */
const NEXT_IS_REAL_SENTENCE_RE = /^\.\s+\p{Lu}\p{Ll}{2,}/u;
/**
 * Short currency-abbreviation tail (zł, Kč, gr, Ft, kr,
 * лв, USD, PLN, EUR, …). When a period follows one of
 * these and the next token starts uppercase, treat it as
 * a sentence boundary even though the tail is too short
 * to satisfy `SENTENCE_TAIL_RE`. Without this, amount
 * triggers using `to-next-comma` swallow the following
 * clause: `"w kwocie 1000 zł. Termin płatności…"`.
 *
 * Currency codes are typically uppercase (`USD`, `PLN`)
 * but appear lowercased in informal writing (`pln`, `eur`);
 * local names mix case (`zł`, `Kč`, `Ft`); symbols
 * (`€`, `$`, `£`) appear after the amount as well. The
 * negative lookbehind on a letter ensures the abbreviation
 * is matched only as a standalone token; symbols are
 * matched unconditionally since they are not letters.
 */
const CURRENCY_TAIL_RE =
  /(?:(?<![\p{L}])(?:zł|Kč|gr|Ft|kr|лв|USD|PLN|EUR|CZK|GBP|CHF|HUF|RON|SEK|NOK|DKK)|[€$£])$/iu;
// Numeric sentence tail: a digit immediately before the
// period (e.g. monetary amounts "R$ 1.000,00." or
// "EUR 5.000.") signals a sentence end too, so amount
// triggers do not consume the next clause.
const NUMERIC_SENTENCE_TAIL_RE = /\d$/;

const isSentenceTerminator = (text: string, periodIndex: number): boolean => {
  const tail = text.slice(periodIndex);
  if (!NEXT_IS_SENTENCE_START_RE.test(tail)) {
    return false;
  }
  const head = text.slice(0, periodIndex);
  if (
    SENTENCE_TAIL_RE.test(head) ||
    CURRENCY_TAIL_RE.test(head) ||
    NUMERIC_SENTENCE_TAIL_RE.test(head)
  ) {
    return true;
  }
  // Proper-noun head (short city names like "Łódź.",
  // "Brno.", "York.") gated by a real-word next clause
  // to avoid breaking on title chains ("Mrs. Smith Inc.").
  return PROPER_NOUN_HEAD_RE.test(head) && NEXT_IS_REAL_SENTENCE_RE.test(tail);
};

/**
 * Field-label keywords that terminate address scanning.
 * When a comma in the address strategy is followed by
 * one of these, the address stops before the keyword.
 *
 * The list is sourced from
 * `data/address-stop-keywords.json` (per-language so new
 * languages can drop in their own labels without
 * touching this file). `loadAddressStopKeywords` unions
 * every language into a single longest-first array;
 * `getAddressStopKeywordsSync` returns the cached union
 * and falls back to a seed list so the strategy keeps
 * working before the warmup promise resolves.
 *
 * The address strategy doesn't know the document
 * language, so a flat union is intentional: any
 * language's labels can appear in any address.
 */
const ADDRESS_STOP_KEYWORDS_SEED: readonly string[] = [
  "číslo účtu",
  "registrační",
  "zastoupen",
  "bankovní",
  "e-mail",
  "telefon",
  "jednatel",
  "ředitel",
  "datová",
  "vložka",
  "sp.zn.",
  "oddíl",
  "swift",
  "email",
  "iban",
  "dič",
  "ičo",
  "tel",
  "č.ú.",
  "bic",
  "ič",
];

let addressStopKeywordsCache: readonly string[] | null = null;
let addressStopKeywordsPromise: Promise<readonly string[]> | null = null;

const loadAddressStopKeywords = async (): Promise<readonly string[]> => {
  if (addressStopKeywordsCache) return addressStopKeywordsCache;
  if (addressStopKeywordsPromise) return addressStopKeywordsPromise;
  addressStopKeywordsPromise = (async () => {
    let data: Record<string, unknown> = {};
    try {
      const mod = await import("../data/address-stop-keywords.json");
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      const parsed =
        (mod as { default?: Record<string, unknown> }).default ?? mod;
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.warn(
        "[anonymize] triggers: failed to load " +
          "address-stop-keywords.json, falling back to " +
          "seed list:",
        err,
      );
    }
    const seen = new Set<string>();
    const out: string[] = [];
    const addAll = (list: readonly string[]): void => {
      for (const kw of list) {
        if (typeof kw !== "string" || kw.length === 0) continue;
        const lower = kw.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(lower);
      }
    };
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(value)) continue;
      addAll(value as readonly string[]);
    }
    addAll(ADDRESS_STOP_KEYWORDS_SEED);
    // Sort longest-first so multi-word labels
    // ("bankové spojenie", "číslo účtu") match
    // before nested shorter ones ("č.").
    out.sort((a, b) => b.length - a.length);
    addressStopKeywordsCache = out;
    return out;
  })();
  return addressStopKeywordsPromise;
};

const getAddressStopKeywordsSync = (): readonly string[] =>
  addressStopKeywordsCache ?? ADDRESS_STOP_KEYWORDS_SEED;

/**
 * Warm the address-stop-keywords cache. Pipeline callers
 * await this before invoking trigger detection so the
 * synchronous `extractValue` path uses the merged list
 * instead of the seed fallback.
 */
export const warmAddressStopKeywords = async (): Promise<void> => {
  await loadAddressStopKeywords();
};

// Hard cap for unterminated trigger values. Applies to
// strategies that scan forward until a delimiter
// (`to-next-comma`, `to-end-of-line`). Prevents a missing
// delimiter — common in HTML-flattened or single-paragraph
// PDFs where a whole signature block lives on one line —
// from turning a trigger into a multi-hundred-character
// entity. 100 chars covers normal full-name + address
// lines while bounding pathological inputs.
const MAX_TRIGGER_VALUE_LEN = 100;
const MIN_TRIGGER_PHONE_DIGITS = 5;
const TRIGGER_LOOKAHEAD_MARGIN = 128;
const LINE_TRIGGER_LOOKAHEAD = 2_048;
const MATCH_PATTERN_LOOKAHEAD = 512;
const PHONE_VALUE_START_RE = /^[+(\d]/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}\b/;
const INLINE_FIELD_LABEL_RE = /\b[\p{L}][\p{L}\p{M} /-]{1,32}:/u;
const INLINE_FIELD_LABEL_STOP_RE =
  /(?:^|[^\S\n\t])[\p{L}][\p{L}\p{M} /-]{1,32}:/u;

const capAtWordBoundary = (valueText: string, cap: number): number => {
  let capped = cap;
  const isWordChar = (i: number): boolean =>
    /[\p{L}\p{N}]/u.test(valueText[i] ?? "");
  while (capped > 0 && isWordChar(capped - 1) && isWordChar(capped)) {
    capped--;
  }
  return capped;
};

const isPlausiblePhoneTriggerValue = (value: string): boolean => {
  const trimmed = value.trimStart();
  if (!PHONE_VALUE_START_RE.test(trimmed)) {
    return false;
  }
  if (ISO_DATE_PREFIX_RE.test(trimmed)) {
    return false;
  }
  if (INLINE_FIELD_LABEL_RE.test(trimmed)) {
    return false;
  }
  let digits = 0;
  for (const ch of trimmed) {
    if (/\d/.test(ch)) {
      digits++;
    }
  }
  return digits >= MIN_TRIGGER_PHONE_DIGITS;
};

const getTriggerLookahead = (strategy: TriggerRule["strategy"]): number => {
  switch (strategy.type) {
    case "to-next-comma":
      return (strategy.maxLength ?? 100) + TRIGGER_LOOKAHEAD_MARGIN;
    case "to-end-of-line":
      return LINE_TRIGGER_LOOKAHEAD;
    case "n-words":
      return strategy.count * 64 + TRIGGER_LOOKAHEAD_MARGIN;
    case "company-id-value":
      return 256;
    case "address":
      return (strategy.maxChars ?? 120) + TRIGGER_LOOKAHEAD_MARGIN;
    case "match-pattern":
      return MATCH_PATTERN_LOOKAHEAD;
    default: {
      const _exhaustive: never = strategy;
      throw new Error(
        `Unknown trigger strategy: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
};

const extractValue = (
  text: string,
  triggerEnd: number,
  strategy: TriggerRule["strategy"],
  label?: string,
): {
  start: number;
  end: number;
  text: string;
} | null => {
  const lookaheadEnd = Math.min(
    text.length,
    triggerEnd + getTriggerLookahead(strategy),
  );
  const remaining = text.slice(triggerEnd, lookaheadEnd);
  // Strip leading whitespace, colons, semicolons —
  // triggers are often followed by ": \t\t\t" in
  // formatted documents.
  const stripped = remaining.replace(/^[\s:;]+/, "");
  const trimmedOffset = remaining.length - stripped.length;
  const valueStart = triggerEnd + trimmedOffset;
  const valueText = stripped;

  if (valueText.length === 0) {
    return null;
  }

  switch (strategy.type) {
    case "to-next-comma": {
      // Stop at comma, newline, or opening parenthesis.
      // Parens mark defined-term clauses in legal text
      // (e.g., "(dále jen ...)") and should not be
      // captured as part of a name/address.
      // When a comma is followed by a known post-nominal
      // degree (Ph.D., CSc., MBA), skip it and continue
      // so "RNDr. Filipem Hartvichem, Ph.D., CSc."
      // captures the full name with degrees.
      // Also stop at any of the trigger's configured
      // `stopWords` so e.g. a court trigger ("Městským
      // soudem v Praze") doesn't sweep into the following
      // clause ("dne 1. 1. 2020") when the comma is
      // missing.
      const stopWords = strategy.stopWords ?? [];
      const stopWordRe =
        stopWords.length > 0
          ? new RegExp(
              `^(?:${stopWords
                .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join("|")})(?![\\p{L}\\p{N}])`,
              "iu",
            )
          : null;
      let end = 0;

      while (end < valueText.length) {
        const ch = valueText[end];
        // Hard stops: newline, paren, tab, semicolon
        if (ch !== undefined && COMMA_STOP_CHARS.has(ch)) {
          break;
        }
        // Sentence terminator: a period that genuinely ends
        // a clause ("…State of Louisiana shall govern its
        // construction. SECTION 3.05…"). The helper rejects
        // abbreviation dots (Ste./RNDr./Mr.) by requiring a
        // real word before the period.
        if (ch === "." && isSentenceTerminator(valueText, end)) {
          break;
        }
        // Trigger-supplied stop words (e.g. "dne", "vložka"
        // for court triggers). Only check at word starts so
        // a stopword that happens to appear inside a longer
        // token doesn't terminate prematurely.
        if (
          stopWordRe !== null &&
          (end === 0 || !/[\p{L}\p{N}]/u.test(valueText[end - 1] ?? "")) &&
          stopWordRe.test(valueText.slice(end))
        ) {
          break;
        }
        // Comma: for person triggers, check if followed
        // by a post-nominal degree (Ph.D., CSc.) and
        // skip past it. Non-person triggers stop here.
        if (ch === ",") {
          const afterComma = valueText.slice(end);
          // Decimal separator: comma followed by digit or
          // dash notation ("0,05%", "1.529,50 Kč",
          // "98.000,- Kč", "98.000,-- Kč")
          if (DECIMAL_COMMA_RE.test(afterComma)) {
            end++;
            continue;
          }
          const degreeMatch =
            label === "person" ? POST_NOMINAL_RE.exec(afterComma) : null;
          if (degreeMatch) {
            // Skip the comma + degree, continue scan
            end += degreeMatch[0].length;
            continue;
          }
          // Regular comma — stop here
          break;
        }
        end++;
      }

      // Per-trigger hard length cap. Applies even when a
      // stop char was found, so jurisdiction triggers
      // ("State of Delaware") cannot absorb forum-selection
      // clauses that legitimately end at a comma sentences
      // away ("…in the event any dispute arises out of…").
      // When no stop char was found, the cap also acts as
      // the unterminated-value fallback; default to 100
      // when the strategy does not configure one. When
      // capping, retreat to the previous word boundary so
      // the returned span never ends mid-word.
      const lengthCap = strategy.maxLength ?? 100;
      if (end > lengthCap) {
        end = capAtWordBoundary(valueText, lengthCap);
      }

      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces = rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "to-end-of-line": {
      // Only capture on the SAME line as the trigger. The
      // generic leading-whitespace strip above swallows
      // newlines, which would let a header-style trigger
      // ("Bankovní spojení\nKupní cena bude uhrazena na ...")
      // consume the next line wholesale. If the strip
      // crossed a newline, the trigger has no inline value
      // and the strategy emits nothing.
      const consumed = remaining.length - valueText.length;
      if (consumed > 0 && remaining.slice(0, consumed).includes("\n")) {
        return null;
      }
      // Stop at newline or tab (tab separates cells
      // in DOCX table rows).
      const LINE_STOPS = ["\n", "\t"];
      let end = valueText.length;
      let foundLineStop = false;
      for (const ch of LINE_STOPS) {
        const idx = valueText.indexOf(ch);
        if (idx !== -1 && idx < end) {
          end = idx;
          foundLineStop = true;
        }
      }
      if (label === "phone number") {
        const inlineLabel = INLINE_FIELD_LABEL_STOP_RE.exec(
          valueText.slice(0, end),
        );
        if (inlineLabel) {
          end = inlineLabel.index;
          foundLineStop = true;
        }
      }
      // Cap only when no real line delimiter was found. HTML-
      // flattened text and signature blocks routinely pack
      // hundreds of chars (a chain of "Phone:" / "Name:"
      // pseudo-fields) onto one logical line; newline-terminated
      // values should still capture through the delimiter.
      if (!foundLineStop) {
        end = capAtWordBoundary(
          valueText,
          Math.min(end, MAX_TRIGGER_VALUE_LEN),
        );
      }
      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces = rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "n-words": {
      // Respect tab as a cell boundary (DOCX table
      // rows use tabs between columns).
      const tabIdx = valueText.indexOf("\t");
      const cellText = tabIdx !== -1 ? valueText.slice(0, tabIdx) : valueText;
      // Skip punctuation-only tokens (colons, dashes)
      // so "datová schránka : hsaxra8" captures
      // "hsaxra8" not ":"
      const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
      // Skip generic "number" markers (PT: "nº/n°/n.",
      // FR/IT/ES use "n°", general "№") so triggers
      // like "OAB/SP nº 123456" capture the actual
      // identifier, not the marker.
      const NUMBER_MARKER = /^(?:n[ºo°.]|№)$/i;
      const allTokens = cellText.split(WHITESPACE_RE);
      const words = allTokens
        .filter((w) => !PUNCT_ONLY.test(w) && !NUMBER_MARKER.test(w))
        .slice(0, strategy.count);
      if (words.length === 0) {
        return null;
      }
      // Find span of the first real word
      const firstWord = words[0];
      if (firstWord === undefined) {
        return null;
      }
      const firstIdx = cellText.indexOf(firstWord);
      let actualEnd = firstIdx + firstWord.length;
      // If multiple words, extend to last one
      let searchPos = actualEnd;
      for (let wi = 1; wi < words.length; wi++) {
        const w = words[wi];
        if (w === undefined) {
          break;
        }
        const wIdx = cellText.indexOf(w, searchPos);
        if (wIdx === -1) break;
        actualEnd = wIdx + w.length;
        searchPos = actualEnd;
      }
      return {
        start: valueStart + firstIdx,
        end: valueStart + actualEnd,
        text: cellText.slice(firstIdx, actualEnd),
      };
    }

    case "company-id-value": {
      // Work from the raw remaining text (before the
      // upstream trimStart) so we can require at least
      // a colon or whitespace separator between the
      // keyword and value (e.g., "IČO: 12345678" or
      // "IČO 12345678", but not "IČO12345678").
      //
      // Exception: when the trigger itself ends in a
      // number-marker character ("n°", "№", "#"), the
      // value can follow the marker without any
      // intervening separator ("SIREN n°123456789"). In
      // that case we accept an empty separator too.
      const raw = text.slice(triggerEnd);
      const triggerLastChar = text[triggerEnd - 1] ?? "";
      const allowEmptySep =
        triggerLastChar === "°" ||
        triggerLastChar === "º" ||
        triggerLastChar === "№" ||
        triggerLastChar === "#";
      const sepRe = allowEmptySep ? /^(?:\s*:\s*|\s+|)/ : /^(?:\s*:\s*|\s+)/;
      const sepMatch = sepRe.exec(raw);
      if (!sepMatch) {
        return null;
      }
      let afterSep = raw.slice(sepMatch[0].length);
      // Skip a leading number-label word (e.g.
      // "PESEL nr 44051401458", "NIP numer 1234567890",
      // "REGON № 123456789", "RG nº 12.345.678-9",
      // "CPF n° 123.456.789-00") that may appear between
      // the trigger and the value. The label is consumed
      // along with its trailing separator so the
      // case-insensitive prefix regex below cannot mistake
      // it for a VAT country prefix like "cz"/"pl".
      const labelMatch =
        /^(?:nr\.?|numer|n[ºo°.]|№|no\.?)(?:\s*:\s*|\s+)/i.exec(afterSep);
      let labelOffset = 0;
      if (labelMatch) {
        labelOffset = labelMatch[0].length;
        afterSep = afterSep.slice(labelOffset);
      }
      // Value shape: optional country prefix (e.g. "CZ",
      // "PL", "FR"), optional whitespace, an optional
      // 2-char alphanumeric key with optional trailing
      // space (covers spaced French VAT keys whose first
      // char is a letter, like "FR A1 123456789" or
      // "FR AB 123456789"), then a digit, then 4+ value
      // chars. The trailing class permits letters so
      // alphanumeric VAT keys like "FR1A123456789" and
      // French NIR Corsican department codes like
      // "1 84 12 2A 075 …" are captured. A letter is only
      // admitted when it is glued directly to a preceding
      // digit (`(?<=\d)[A-Z]`), so the regex cannot grow
      // past whitespace into a one-letter prose word
      // ("SIREN 123456789 a son siège" stops at "9").
      // Case-insensitive so lowercase variants
      // ("DIČ cz12345678", "VAT number pl1234567890")
      // still validate via stdnum downstream. An optional
      // 2-char alphanumeric key with optional trailing
      // space covers spaced French VAT keys whose first
      // char is a letter, like "FR A1 123456789" or
      // "FR AB 123456789". Dots are permitted inside the
      // value so dotted IDs such as Brazilian RG
      // ("12.345.678-9") and dotted CPF/CNPJ values
      // introduced by triggers are captured. Require at
      // least two leading digits before the dot-permitting
      // tail so single-digit dotted dates ("6.11.2025")
      // after triggers like "DNI" or "RG" do not slide
      // in. Stricter checksum validation for CPF/CNPJ runs
      // in the regex detector. A letter is only admitted
      // when it is glued directly to a preceding digit
      // (`(?<=\d)[A-Z]`), so the regex cannot grow past
      // whitespace into a one-letter prose word
      // ("SIREN 123456789 a son siège" stops at "9").
      // This still captures alphanumeric VAT keys like
      // "FR1A123456789" and French NIR Corsican department
      // codes like "1 84 12 2A 075 …".
      const idMatch =
        /^[A-Z]{0,6}\s?(?:[A-Z0-9]{2}\s?)?\d{2}(?:(?<=\d)[A-Z]|[\d\s.\-/]){3,}/i.exec(
          afterSep,
        );
      if (!idMatch) {
        return null;
      }
      // Optional trailing check letter must sit flush against
      // the last digit of the base match (no intervening
      // whitespace). This captures Spanish DNI / NIE / CIF /
      // NIF check letters (e.g. `DNI 12345678Z`,
      // `NIF A12345678J`) without sliding into the next word.
      const baseEndsOnDigit = /\d$/.test(idMatch[0]);
      const trailingLetterMatch = baseEndsOnDigit
        ? /^[A-Z]/i.exec(afterSep.slice(idMatch[0].length))
        : null;
      const idRaw = trailingLetterMatch
        ? idMatch[0] + trailingLetterMatch[0]
        : idMatch[0];
      const idText = idRaw.trim();
      const leadingSpaces = idMatch[0].length - idMatch[0].trimStart().length;
      const idStart =
        triggerEnd +
        sepMatch[0].length +
        labelOffset +
        // idMatch.index is always 0 (anchored ^ regex)
        leadingSpaces;
      return {
        start: idStart,
        end: idStart + idText.length,
        text: idText,
      };
    }

    case "address": {
      // Walk through comma-separated segments.
      // Continue through a comma if the next segment
      // starts with a digit (PSČ like "110 00") or
      // an uppercase letter (city like "Praha").
      // Stop at: newline, opening paren "(", tab,
      // or a period that is NOT an abbreviation
      // (abbreviation = period followed by a space
      // and a lowercase letter, e.g. "nábř. ").
      const maxLen = strategy.maxChars ?? 120;
      const UPPER_RE = /\p{Lu}/u;
      const stopKeywords = getAddressStopKeywordsSync();
      let end = 0;

      while (end < valueText.length && end < maxLen) {
        const ch = valueText[end];

        // Hard stops: newline, opening paren.
        // Tabs are NOT hard stops — they appear as
        // formatting in structured documents between
        // trigger and value.
        if (ch === "\n" || ch === "(") {
          break;
        }

        // Whitespace boundary: when an address has no
        // commas (e.g. headline-style triggers like
        // "Adresse : 10 rue de la Paix Email : a@b.fr"),
        // the comma-scoped stop-keyword check below
        // never fires. Re-check the stop list at every
        // whitespace boundary so a following field
        // label terminates the address before its value.
        if (ch === " " || ch === "\t") {
          const afterWs = valueText.slice(end).trimStart().toLowerCase();
          const hitsKeyword = stopKeywords.some((kw) => {
            if (!afterWs.startsWith(kw)) return false;
            const next = afterWs[kw.length];
            return next === undefined || /[\s:;.,!?()\d]/.test(next);
          });
          if (hitsKeyword) {
            break;
          }
        }

        // Period: stop unless it's an abbreviation.
        // Abbreviation patterns in Czech addresses:
        //   "nábř. Kpt." — period + space + letter
        //   "č.p." — period + letter (no space)
        //   "1000/7." — period at end of address
        if (ch === ".") {
          const next = valueText[end + 1];
          const afterNext = valueText[end + 2];
          // Field-label check: if the text after the
          // period (with optional space) begins with a
          // known stop-keyword (e.g. "C.F.", "P.IVA"),
          // treat the period as a clause boundary even
          // when followed by a letter/digit. Without
          // this, "Via Roma 1. C.F. 12345678901" would
          // absorb the tax-id label into the address.
          const afterPeriod = valueText
            .slice(end + 1)
            .replace(/^\s+/, "")
            .toLowerCase();
          if (afterPeriod.length > 0) {
            const hitsKeywordAfterPeriod = getAddressStopKeywordsSync().some(
              (kw) => {
                if (!afterPeriod.startsWith(kw)) return false;
                const afterKw = afterPeriod[kw.length];
                return afterKw === undefined || /[\s:;.,!?()\d]/.test(afterKw);
              },
            );
            if (hitsKeywordAfterPeriod) {
              break;
            }
          }
          // "č.p." or "Kpt.J" — period immediately
          // followed by letter or digit
          if (next !== undefined && (/\p{L}/u.test(next) || /\d/.test(next))) {
            end++;
            continue;
          }
          // "nábř. Kpt." or "ul. nová" — period +
          // space + any letter or digit. Treat as an
          // abbreviation unless this is a genuine
          // sentence boundary (real word before, then
          // ". " + uppercase start) — that case
          // happens when the address has already ended
          // and the next clause begins, e.g.
          // "z siedzibą w Warszawie. Kapitał…" /
          // "Adresse : 10 rue de la Paix. Jean Dupont…".
          if (
            next === " " &&
            afterNext !== undefined &&
            (/\p{L}/u.test(afterNext) || /\d/.test(afterNext))
          ) {
            if (isSentenceTerminator(valueText, end)) {
              break;
            }
            end++;
            continue;
          }
          // Period at end of address — stop but
          // don't include the period
          break;
        }

        // Comma: look ahead to see if address continues
        if (ch === ",") {
          // Skip comma + whitespace, check next char
          let peek = end + 1;
          while (
            peek < valueText.length &&
            (valueText[peek] === " " || valueText[peek] === "\t")
          ) {
            peek++;
          }
          const peekCh = valueText[peek];
          if (peekCh === undefined) {
            break;
          }
          // Check for field-label keywords after
          // comma before continuing. Keywords like
          // "IČ", "DIČ" start new fields. Loaded
          // from per-language JSON config so every
          // enabled language's stop words apply.
          const afterComma = valueText
            .slice(end + 1)
            .trimStart()
            .toLowerCase();
          const hitsKeyword = getAddressStopKeywordsSync().some((kw) => {
            if (!afterComma.startsWith(kw)) return false;
            // Guard: next char must be a delimiter
            // or digit to avoid truncating city
            // names like "Telč" on "tel". Digits
            // are included so "IČ25672541" (no
            // space) still triggers a stop.
            const next = afterComma[kw.length];
            return next === undefined || /[\s:;.,!?()\d]/.test(next);
          });
          if (hitsKeyword) {
            break;
          }
          // Continue if next segment starts with
          // digit (PSČ) or uppercase (city name)
          if (/\d/.test(peekCh) || UPPER_RE.test(peekCh)) {
            end++;
            continue;
          }
          // Otherwise stop at this comma
          break;
        }

        end++;
      }

      // When the loop stopped at maxLen, trim back to
      // the last word boundary so fixPartialWords does
      // not extend the entity beyond the configured max.
      if (end >= maxLen) {
        const lastSpace = valueText.lastIndexOf(" ", end - 1);
        if (lastSpace > 0) {
          end = lastSpace;
        }
      }

      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces = rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "match-pattern": {
      // Anchor the configured pattern to the start of the
      // value text (after the generic leading-whitespace/
      // colon strip above). This prevents a missing or
      // placeholder value from stealing the next numeric
      // field on the same line: e.g. with a phone trigger
      // applied to `Téléphone : non communiqué SIREN :
      // 123456789`, an unanchored search would pull the
      // SIREN digits into the phone entity. Stops at the
      // first newline so a header-style trigger cannot
      // pull a value from a following line. The compiled
      // regex strips `g`/`y` flags so it stays stateless
      // across calls.
      const nlIdx = valueText.indexOf("\n");
      const searchText = nlIdx === -1 ? valueText : valueText.slice(0, nlIdx);
      if (searchText.length === 0) {
        return null;
      }
      const flags = (strategy.flags ?? "").replace(/[gy]/g, "");
      // Wrap the pattern in a non-capturing group so a
      // leading anchor authored in the config (e.g. `^`)
      // and authored alternation precedence still work
      // when the engine prepends its own start anchor.
      const anchoredSource = `^(?:${strategy.pattern})`;
      let re: RegExp;
      try {
        re = new RegExp(anchoredSource, flags);
      } catch {
        return null;
      }
      const m = re.exec(searchText);
      if (!m || m[0].length === 0) {
        return null;
      }
      const matchStart = m.index;
      const matchEnd = matchStart + m[0].length;
      return {
        start: valueStart + matchStart,
        end: valueStart + matchEnd,
        text: m[0],
      };
    }

    default:
      return null;
  }
};

// ── Match processor ─────────────────────────────────

/**
 * Process trigger matches from the unified search.
 * Receives all matches; filters to the trigger slice
 * via sliceStart/sliceEnd. Uses fullText for value
 * extraction (the unified search runs on lowercased
 * text, but extraction needs original casing).
 */
export const processTriggerMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  rules: readonly TriggerRule[],
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

    const localIdx = idx - sliceStart;

    // Left word-boundary: reject if preceded by a
    // letter (prevents partial keyword matches).
    if (match.start > 0 && LETTER_RE.test(fullText[match.start - 1] ?? "")) {
      continue;
    }

    const rule = rules[localIdx];
    if (!rule) {
      continue;
    }

    // Right word-boundary: reject only when the trigger
    // ends with a letter AND is followed by another
    // letter (which would mean the keyword bleeds into
    // a longer word, e.g. "pan" inside "pana"). Triggers
    // ending in punctuation (`:`, `'`, `’`, `°`, `.`, …)
    // or whitespace are already self-bounded: whatever
    // follows cannot extend the keyword token, so any
    // following character (letter, digit, etc.) is fine.
    const triggerLastChar = rule.trigger.at(-1) ?? "";
    if (
      LETTER_RE.test(triggerLastChar) &&
      LETTER_RE.test(fullText[match.end] ?? "")
    ) {
      continue;
    }

    const triggerEnd = match.end;
    const rawValue = extractValue(
      fullText,
      triggerEnd,
      rule.strategy,
      rule.label,
    );
    const value = rawValue ? stripQuotes(rawValue) : null;

    if (value) {
      // Apply declarative validations to the captured
      // value text (not the full entity including
      // trigger). This is intentional: validations
      // like min-length should test the extracted
      // value, not the trigger keyword itself.
      if (!applyValidations(value.text, rule.validations)) {
        continue;
      }

      // Label-shape invariant: a phone-number entity
      // must start like a phone value and contain enough
      // digits. Triggers like
      // a multilingual "Phone:" / "PHONE:" / "Tel.:"
      // can fire on signature blocks where the digit
      // value is blank ("Phone: Date: 2026-05-15 ...");
      // without this check the strategy emits a long
      // high-priority phone entity that can overlap and
      // suppress the later real phone number.
      if (
        rule.label === "phone number" &&
        !isPlausiblePhoneTriggerValue(value.text)
      ) {
        continue;
      }

      // When includeTrigger is set, the entity span
      // starts at the trigger match, not the value.
      const entityStart = rule.includeTrigger ? match.start : value.start;
      const entityEnd = value.end;
      const entityText = fullText.slice(entityStart, entityEnd);

      // Legal form reclassification: any person-labeled
      // trigger whose captured text contains a definitive
      // legal form suffix is reclassified as organization.
      // This is universal — every person with a legal form
      // is an organisation, no per-group config needed.
      const effectiveLabel =
        rule.label === "person" && hasKnownLegalFormSuffix(entityText)
          ? "organization"
          : rule.label;

      results.push({
        start: entityStart,
        end: entityEnd,
        label: effectiveLabel,
        text: entityText,
        score: TRIGGER_SCORE,
        source: DETECTION_SOURCES.TRIGGER,
      });
    }
  }

  return results;
};

// Re-export for testing
export { expandTriggerGroups, compileValidations, applyValidations };
