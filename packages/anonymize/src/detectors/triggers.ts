import type { Match } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type { Entity, TriggerRule } from "../types";

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;
const LETTER_RE = /\p{L}/u;

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

  const tryLoad = async (path: string) => {
    try {
      const mod = await import(path);
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
      const rows = (
        mod as {
          default: readonly TriggerConfigRow[];
        }
      ).default;
      rules.push(...mapConfig(rows));
    } catch {
      // Data package not installed or file missing
    }
  };

  await Promise.all([
    tryLoad(
      "@stll/anonymize-data/config/triggers.cs.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.de.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.en.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.es.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.fr.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.hu.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.it.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.pl.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.ro.json",
    ),
    tryLoad(
      "@stll/anonymize-data/config/triggers.sv.json",
    ),
  ]);

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
      const words = cellText
        .split(WHITESPACE_RE)
        .slice(0, strategy.count);
      if (words.length === 0) {
        return null;
      }
      let actualEnd = 0;
      let searchPos = 0;
      for (const word of words) {
        const wordIdx = cellText.indexOf(
          word,
          searchPos,
        );
        actualEnd = wordIdx + word.length;
        searchPos = actualEnd;
      }
      return {
        start: valueStart,
        end: valueStart + actualEnd,
        text: cellText.slice(0, actualEnd),
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
            (UPPER_RE.test(next) || /\d/.test(next))
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
