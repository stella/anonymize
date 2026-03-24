import type { Match } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type { Entity, TriggerRule } from "../types";
import {
  loadLanguageConfigs,
} from "../util/lang-loader";

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;
const LETTER_RE = /\p{L}/u;
const UPPERCASE_START_RE = /^\p{Lu}/u;
const DATOVA_SCHRANKA_RE = /^[a-z0-9]{7}$/i;

type TriggerConfigRow = {
  trigger: string;
  label: string;
  strategy: TriggerRule["strategy"];
};

const mapConfig = (
  rows: readonly TriggerConfigRow[],
): readonly TriggerRule[] =>
  rows.map((row) => ({
    trigger: row.trigger,
    label: row.label,
    strategy: row.strategy,
  }));

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

  const allRows = await loadLanguageConfigs<
    readonly TriggerConfigRow[]
  >(
    "triggers",
    (mod) => {
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      const m = mod as {
        default?: readonly TriggerConfigRow[];
      };
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      return (m.default ?? mod) as
        readonly TriggerConfigRow[];
    },
  );
  for (const rows of allRows) {
    if (!Array.isArray(rows)) {
      console.warn(
        "[anonymize] triggers: unexpected " +
          "config shape, skipping",
      );
      continue;
    }
    rules.push(...mapConfig(rows));
  }

  // Build patterns from lowercased trigger strings.
  // rules[i] corresponds to patterns[i].
  // Plain lowercased strings — the unified builder
  // sets caseInsensitive globally on the AC.
  const patterns: string[] = rules.map(
    (r) => r.trigger.toLowerCase(),
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

const extractValue = (
  text: string,
  triggerEnd: number,
  strategy: TriggerRule["strategy"],
): {
  start: number;
  end: number;
  text: string;
} | null => {
  const remaining = text.slice(triggerEnd);
  const trimmedOffset =
    remaining.length - remaining.trimStart().length;
  const valueStart = triggerEnd + trimmedOffset;
  const valueText = remaining.trimStart();

  if (valueText.length === 0) {
    return null;
  }

  switch (strategy.type) {
    case "to-next-comma": {
      // Stop at comma, newline, or opening parenthesis.
      // Parens mark defined-term clauses in legal text
      // (e.g., "(dále jen ...)") and should not be
      // captured as part of a name/address.
      const STOP_CHARS = [",", "\n", "(", "\t"];
      let end = valueText.length;
      let foundStop = false;
      for (const ch of STOP_CHARS) {
        const idx = valueText.indexOf(ch);
        if (idx !== -1 && idx < end) {
          end = idx;
          foundStop = true;
        }
      }
      // Only cap at 100 chars when no stop char was found
      // (fallback for unterminated values). When a stop
      // char exists, respect its position even if > 100.
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
      const LINE_STOPS = ["\n", "\t"];
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
      const sepMatch =
        /^(?:\s*:\s*|\s+)/.exec(raw);
      if (!sepMatch) {
        return null;
      }
      const afterSep = raw.slice(sepMatch[0].length);
      const idMatch =
        /^[A-Z]{0,6}\s?\d[\d\s\-/]{4,}/i.exec(
          afterSep,
        );
      if (!idMatch) {
        return null;
      }
      const idText = idMatch[0].trim();
      const leadingSpaces = idMatch[0].length -
        idMatch[0].trimStart().length;
      const idStart = triggerEnd +
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

        // Hard stops: newline, tab, opening paren
        if (ch === "\n" || ch === "\t" || ch === "(") {
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
    );
    const value = rawValue
      ? stripQuotes(rawValue)
      : null;

    if (value) {
      // Person triggers require the captured value to
      // start with an uppercase letter. This prevents
      // false positives like "kontaktní osoba pro
      // plnění této smlouvy :" from blindly anonymizing
      // whatever follows.
      if (
        rule.label === "person" &&
        !UPPERCASE_START_RE.test(value.text)
      ) {
        continue;
      }

      // Datová schránka IDs are exactly 7 alphanumeric
      // characters. Reject captures that don't match.
      if (
        rule.trigger.includes("schránka") &&
        !DATOVA_SCHRANKA_RE.test(value.text)
      ) {
        continue;
      }

      results.push({
        start: value.start,
        end: value.end,
        label: rule.label,
        text: value.text,
        score: TRIGGER_SCORE,
        source: DETECTION_SOURCES.TRIGGER,
      });
    }
  }

  return results;
};
