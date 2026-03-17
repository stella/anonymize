import { AhoCorasick } from "@stll/aho-corasick";

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

// ── Cached trigger AC automaton ─────────────────────

type TriggerAutomaton = {
  ac: AhoCorasick;
  /** Parallel array: rules[match.pattern] → rule */
  rules: readonly TriggerRule[];
};

let cached: TriggerAutomaton | null = null;

const loadAutomaton = async (): Promise<
  TriggerAutomaton | null
> => {
  if (cached) {
    return cached;
  }

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
  ]);

  if (rules.length === 0) {
    return null;
  }

  // Build AC from lowercased trigger strings.
  // rules[i] corresponds to patterns[i].
  const patterns = rules.map((r) =>
    r.trigger.toLowerCase(),
  );
  const ac = new AhoCorasick(patterns, {
    caseInsensitive: true,
  });

  cached = { ac, rules };
  return cached;
};

// ── Value extraction (unchanged) ────────────────────

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

    default:
      return null;
  }
};

// ── Public API ──────────────────────────────────────

/**
 * Scan text for trigger phrases using a single
 * Aho-Corasick pass. Loads trigger configs from
 * @stll/anonymize-data (optional). The AC automaton
 * and rule metadata are cached after first build.
 *
 * Each AC match is looked up in the parallel rules[]
 * array via match.pattern (O(1)), then extractValue
 * post-processes the hit.
 */
export const detectTriggerPhrases = async (
  fullText: string,
): Promise<Entity[]> => {
  const automaton = await loadAutomaton();

  if (!automaton) {
    return [];
  }

  const results: Entity[] = [];
  const lowerText = fullText.toLowerCase();
  const matches = automaton.ac.findIter(lowerText);

  for (const match of matches) {
    // Word-boundary check: reject if preceded by
    // a letter (prevents matching inside words)
    if (
      match.start > 0 &&
      LETTER_RE.test(lowerText[match.start - 1] ?? "")
    ) {
      continue;
    }

    const rule = automaton.rules[match.pattern];
    if (!rule) {
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
