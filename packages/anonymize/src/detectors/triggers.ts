import type { Match } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type {
  CompiledValidation,
  Entity,
  TriggerGroupConfig,
  TriggerRule,
  TriggerValidation,
} from "../types";
import { POST_NOMINALS } from "../config/titles";
import { LEGAL_SUFFIXES } from "../config/legal-forms";
import { loadLanguageConfigs } from "../util/lang-loader";

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;
const LETTER_RE = /\p{L}/u;

/**
 * Post-nominal degree regex. When a comma-stop is
 * followed by a known post-nominal (Ph.D., CSc., MBA
 * etc.), skip the comma and degree, then continue.
 */
const POST_NOMINAL_RE = new RegExp(
  `^,\\s*(?:${POST_NOMINALS.toSorted(
    (a, b) => b.length - a.length,
  )
    .map((d) =>
      d
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\./g, "\\.\\s*"),
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
const DEFINITIVE_LEGAL_FORMS = LEGAL_SUFFIXES;
// Build case-sensitive regex. Short dot-free forms
// (AG, SE, KG) get word boundaries to prevent substring
// matches. All forms are uppercase in the list; the
// regex is case-sensitive so "se"/"sa" won't match.
const LEGAL_FORM_CHECK_RE = new RegExp(
  DEFINITIVE_LEGAL_FORMS.map((f) => {
    const escaped = f
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\./g, "\\.\\s*");
    const isDotFree = !f.includes(".");
    const isShort = f.length <= 4;
    return isDotFree && isShort
      ? `\\b${escaped}\\b`
      : escaped;
  }).join("|"),
);

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
          re: new RegExp(
            v.pattern,
            (v.flags ?? "").replace(/[gy]/g, ""),
          ),
        };
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

const expandTriggerGroups = (
  groups: TriggerGroupConfig[],
): TriggerRule[] => {
  const rules: TriggerRule[] = [];
  for (const group of groups) {
    const extensions = group.extensions ?? [];
    const compiled = compileValidations(
      group.validations ?? [],
    );

    // Generate trigger variants from the original
    // trigger strings. Extensions are applied once to
    // the base set only (not combinatorially); e.g.,
    // ["add-colon", "normalize-spaces"] produces
    // "trigger:", "trigger\u00A0", but NOT
    // "trigger\u00A0:". This is intentional to avoid
    // exponential variant growth.
    const allTriggers = new Set(group.triggers);
    for (const trigger of group.triggers) {
      if (
        extensions.includes("add-colon") &&
        !trigger.endsWith(":")
      )
        allTriggers.add(`${trigger}:`);
      if (
        extensions.includes("add-trailing-space") &&
        !trigger.endsWith(" ")
      )
        allTriggers.add(`${trigger} `);
      if (
        extensions.includes("add-colon-space") &&
        !trigger.endsWith(": ") &&
        !trigger.endsWith(":")
      )
        allTriggers.add(`${trigger}: `);
      if (extensions.includes("normalize-spaces")) {
        if (trigger.includes(" ")) {
          allTriggers.add(
            trigger.replace(/ /g, "\u00A0"),
          );
        }
      }
    }

    const includeTrigger =
      group.includeTrigger ?? false;

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

/**
 * Build trigger patterns and rules from data configs.
 * Returns string[] for the unified TextSearch
 * builder and the parallel rules array.
 */
export const buildTriggerPatterns = async (): Promise<{
  patterns: string[];
  rules: TriggerRule[];
}> => {
  const rules: TriggerRule[] = [];

  const allGroups = await loadLanguageConfigs<
    readonly TriggerGroupConfig[]
  >(
    "triggers",
    (mod) => {
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      const m = mod as {
        default?: readonly TriggerGroupConfig[];
      };
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      return (m.default ?? mod) as
        readonly TriggerGroupConfig[];
    },
  );
  for (const groups of allGroups) {
    if (!Array.isArray(groups)) {
      console.warn(
        "[anonymize] triggers: unexpected " +
          "config shape, skipping",
      );
      continue;
    }
    rules.push(
      ...expandTriggerGroups(
        groups as TriggerGroupConfig[],
      ),
    );
  }

  // Load global triggers (language-agnostic)
  try {
    const globalMod = await import(
      "@stll/anonymize-data/config/triggers.global.json"
    );
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
    const globalGroups = (
      (globalMod as { default?: unknown }).default ??
      globalMod
    ) as TriggerGroupConfig[];
    if (Array.isArray(globalGroups)) {
      rules.push(
        ...expandTriggerGroups(globalGroups),
      );
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

  // Warn about cross-group trigger duplicates.
  // Duplicates cause redundant AC matches but are
  // not fatal (mergeAndDedup handles overlap).
  const seen = new Map<
    string,
    { label: string; strategy: string }
  >();
  for (const rule of rules) {
    const key = rule.trigger.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      const labelDiff = prev.label !== rule.label;
      const stratDiff =
        prev.strategy !== rule.strategy.type;
      if (labelDiff || stratDiff) {
        console.warn(
          `[anonymize] duplicate trigger` +
            ` "${rule.trigger}":` +
            (labelDiff
              ? ` labels "${prev.label}" vs` +
                ` "${rule.label}"`
              : "") +
            (stratDiff
              ? ` strategies "${prev.strategy}" vs` +
                ` "${rule.strategy.type}"`
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
  const patterns: string[] = rules.map((r) =>
    r.trigger.toLowerCase(),
  );

  return { patterns, rules };
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
  const leadingLen = leadingMatch
    ? leadingMatch[0].length
    : 0;
  const stripped = value.text
    .slice(leadingLen)
    .replace(TRAILING_PUNCT, "");
  if (stripped.length === 0) {
    return null;
  }
  return {
    start: value.start + leadingLen,
    end: value.start + leadingLen + stripped.length,
    text: stripped,
  };
};

/** Hard stop characters for to-next-comma scanning. */
const COMMA_STOP_CHARS = new Set(["\n", "("]);

/**
 * Field-label keywords that terminate address scanning.
 * When a comma in the address strategy is followed by
 * one of these, the address stops before the keyword.
 */
const ADDRESS_STOP_KEYWORDS = [
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
  const remaining = text.slice(triggerEnd);
  // Strip leading whitespace, colons, semicolons —
  // triggers are often followed by ": \t\t\t" in
  // formatted documents.
  const stripped = remaining.replace(
    /^[\s:;]+/,
    "",
  );
  const trimmedOffset =
    remaining.length - stripped.length;
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
      let end = 0;
      let foundStop = false;

      while (end < valueText.length) {
        const ch = valueText[end];
        // Hard stops: newline, paren, tab
        if (
          ch !== undefined &&
          COMMA_STOP_CHARS.has(ch)
        ) {
          foundStop = true;
          break;
        }
        // Comma: for person triggers, check if followed
        // by a post-nominal degree (Ph.D., CSc.) and
        // skip past it. Non-person triggers stop here.
        if (ch === ",") {
          const afterComma = valueText.slice(end);
          const degreeMatch =
            label === "person"
              ? POST_NOMINAL_RE.exec(afterComma)
              : null;
          if (degreeMatch) {
            // Skip the comma + degree, continue scan
            end += degreeMatch[0].length;
            continue;
          }
          // Regular comma — stop here
          foundStop = true;
          break;
        }
        end++;
      }

      // Only cap at 100 chars when no stop char was
      // found (fallback for unterminated values). When
      // a stop char exists, respect its position even
      // if > 100.
      if (!foundStop) {
        end = Math.min(end, 100);
      }

      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces =
        rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "to-end-of-line": {
      // Stop at newline or tab (tab separates cells
      // in DOCX table rows).
      const LINE_STOPS = ["\n"];
      let end = valueText.length;
      for (const ch of LINE_STOPS) {
        const idx = valueText.indexOf(ch);
        if (idx !== -1 && idx < end) {
          end = idx;
        }
      }
      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces =
        rawSlice.length - rawSlice.trimEnd().length;
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
      const cellText =
        tabIdx !== -1
          ? valueText.slice(0, tabIdx)
          : valueText;
      // Skip punctuation-only tokens (colons, dashes)
      // so "datová schránka : hsaxra8" captures
      // "hsaxra8" not ":"
      const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
      const allTokens = cellText.split(WHITESPACE_RE);
      const words = allTokens
        .filter((w) => !PUNCT_ONLY.test(w))
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
      const raw = text.slice(triggerEnd);
      const sepMatch = /^(?:\s*:\s*|\s+)/.exec(raw);
      if (!sepMatch) {
        return null;
      }
      const afterSep = raw.slice(sepMatch[0].length);
      const idMatch =
        /^[A-Z]{0,6}\s?\d[\d\s\-/]{4,}/i.exec(afterSep);
      if (!idMatch) {
        return null;
      }
      const idText = idMatch[0].trim();
      const leadingSpaces =
        idMatch[0].length -
        idMatch[0].trimStart().length;
      const idStart =
        triggerEnd +
        sepMatch[0].length +
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

        // Period: stop unless it's an abbreviation.
        // Abbreviation patterns in Czech addresses:
        //   "nábř. Kpt." — period + space + letter
        //   "č.p." — period + letter (no space)
        //   "1000/7." — period at end of address
        if (ch === ".") {
          const next = valueText[end + 1];
          const afterNext = valueText[end + 2];
          // "č.p." or "Kpt.J" — period immediately
          // followed by letter or digit
          if (
            next !== undefined &&
            (/\p{L}/u.test(next) || /\d/.test(next))
          ) {
            end++;
            continue;
          }
          // "nábř. Kpt." or "ul. nová" — period +
          // space + any letter or digit. In address
          // context, this is always an abbreviation,
          // not end of sentence.
          if (
            next === " " &&
            afterNext !== undefined &&
            (/\p{L}/u.test(afterNext) ||
              /\d/.test(afterNext))
          ) {
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
            (valueText[peek] === " " ||
              valueText[peek] === "\t")
          ) {
            peek++;
          }
          const peekCh = valueText[peek];
          if (peekCh === undefined) {
            break;
          }
          // Check for field-label keywords after
          // comma before continuing. Keywords like
          // "IČ", "DIČ" start new fields.
          const afterComma = valueText
            .slice(end + 1)
            .trimStart()
            .toLowerCase();
          const hitsKeyword =
            ADDRESS_STOP_KEYWORDS.some((kw) => {
              if (!afterComma.startsWith(kw))
                return false;
              // Guard: next char must be a delimiter
              // (not a letter) to avoid truncating
              // city names like "Telč" on "tel".
              const next = afterComma[kw.length];
              return (
                next === undefined ||
                /[\s:;.,!?()]/.test(next)
              );
            });
          if (hitsKeyword) {
            break;
          }
          // Continue if next segment starts with
          // digit (PSČ) or uppercase (city name)
          if (
            /\d/.test(peekCh) ||
            UPPER_RE.test(peekCh)
          ) {
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
        const lastSpace = valueText.lastIndexOf(
          " ",
          end - 1,
        );
        if (lastSpace > 0) {
          end = lastSpace;
        }
      }

      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces =
        rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
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
    if (
      match.start > 0 &&
      LETTER_RE.test(fullText[match.start - 1] ?? "")
    ) {
      continue;
    }

    const rule = rules[localIdx];
    if (!rule) {
      continue;
    }

    // Right word-boundary: reject if followed by a
    // letter — but skip this check when the trigger
    // itself ends with whitespace (e.g., "pan ",
    // "město ") since the trailing space already
    // acts as a boundary delimiter.
    if (
      !rule.trigger.endsWith(" ") &&
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
    const value = rawValue
      ? stripQuotes(rawValue)
      : null;

    if (value) {
      // Apply declarative validations to the captured
      // value text (not the full entity including
      // trigger). This is intentional: validations
      // like min-length should test the extracted
      // value, not the trigger keyword itself.
      if (
        !applyValidations(
          value.text,
          rule.validations,
        )
      ) {
        continue;
      }

      // When includeTrigger is set, the entity span
      // starts at the trigger match, not the value.
      const entityStart = rule.includeTrigger
        ? match.start
        : value.start;
      const entityEnd = value.end;
      const entityText = fullText.slice(
        entityStart,
        entityEnd,
      );

      // Legal form reclassification: any person-labeled
      // trigger whose captured text contains a definitive
      // legal form suffix is reclassified as organization.
      // This is universal — every person with a legal form
      // is an organisation, no per-group config needed.
      const effectiveLabel =
        rule.label === "person" &&
        LEGAL_FORM_CHECK_RE.test(entityText)
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
export {
  expandTriggerGroups,
  compileValidations,
  applyValidations,
};
