import { DETECTION_SOURCES } from "../types";
import type { Entity, TriggerRule } from "../types";

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;

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

let cachedTriggers: readonly TriggerRule[] | null =
  null;

const loadTriggers = async (): Promise<
  readonly TriggerRule[]
> => {
  if (cachedTriggers) {
    return cachedTriggers;
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

  cachedTriggers = rules;
  return rules;
};

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
      const STOP_CHARS = [",", "\n", "("];
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
      const newlineIdx = valueText.indexOf("\n");
      const end =
        newlineIdx !== -1
          ? newlineIdx
          : valueText.length;
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
      const words = valueText
        .split(WHITESPACE_RE)
        .slice(0, strategy.count);
      if (words.length === 0) {
        return null;
      }
      let actualEnd = 0;
      let searchPos = 0;
      for (const word of words) {
        const wordIdx = valueText.indexOf(
          word,
          searchPos,
        );
        actualEnd = wordIdx + word.length;
        searchPos = actualEnd;
      }
      return {
        start: valueStart,
        end: valueStart + actualEnd,
        text: valueText.slice(0, actualEnd),
      };
    }

    default:
      return null;
  }
};

/**
 * Scan text for trigger phrases. Loads trigger
 * configs from @stll/anonymize-data (optional).
 * Returns empty array if data package not installed.
 */
export const detectTriggerPhrases = async (
  fullText: string,
): Promise<Entity[]> => {
  const allTriggers = await loadTriggers();

  if (allTriggers.length === 0) {
    return [];
  }

  const results: Entity[] = [];
  const lowerText = fullText.toLowerCase();

  for (const rule of allTriggers) {
    const lowerTrigger = rule.trigger.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(
        lowerTrigger,
        searchFrom,
      );
      if (idx === -1) {
        break;
      }

      if (
        idx > 0 &&
        /\p{L}/u.test(lowerText[idx - 1] ?? "")
      ) {
        searchFrom = idx + 1;
        continue;
      }

      const triggerEnd = idx + rule.trigger.length;
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

      searchFrom = triggerEnd;
    }
  }

  return results;
};
