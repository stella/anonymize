import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

type CoreferenceConfigRow = {
  pattern: string;
  flags: string;
  label: string;
};

type DefinitionPattern = {
  pattern: RegExp;
};

/**
 * Load coreference definition patterns from per-language
 * JSON configs in @stll/anonymize-data. Follows the same
 * `tryLoad` approach used by triggers.ts.
 */
const loadDefinitionPatterns =
  async (): Promise<DefinitionPattern[]> => {
    const patterns: DefinitionPattern[] = [];

    const tryLoad = async (path: string) => {
      try {
        const mod = await import(path);
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
        const rows = (
          mod as {
            default: readonly CoreferenceConfigRow[];
          }
        ).default;
        for (const row of rows) {
          patterns.push({
            pattern: new RegExp(row.pattern, row.flags),
          });
        }
      } catch {
        // Data package not installed or file missing
      }
    };

    await Promise.all([
      tryLoad(
        "@stll/anonymize-data/config/coreference.cs.json",
      ),
      tryLoad(
        "@stll/anonymize-data/config/coreference.de.json",
      ),
      tryLoad(
        "@stll/anonymize-data/config/coreference.en.json",
      ),
      tryLoad(
        "@stll/anonymize-data/config/coreference.sk.json",
      ),
    ]);

    return patterns;
  };

let _cachedPatterns: DefinitionPattern[] | null = null;

const getDefinitionPatterns =
  async (): Promise<DefinitionPattern[]> => {
    if (_cachedPatterns) {
      return _cachedPatterns;
    }
    _cachedPatterns = await loadDefinitionPatterns();
    return _cachedPatterns;
  };

const SEARCH_WINDOW = 200;

type DefinedTerm = {
  alias: string;
  label: string;
  /** Position of the definition in the source text */
  definitionStart: number;
};

/**
 * Scan for defined-term patterns near known entities.
 *
 * Legal documents universally follow:
 *   "Dr. Heinrich Muller (hereinafter 'the Seller')..."
 *
 * After NER detects the entity, this function scans for
 * definitional patterns within +/-200 chars and extracts
 * the alias. Returns alias + label pairs that can be added
 * to the gazetteer for a full-text re-scan.
 */
export const extractDefinedTerms = async (
  fullText: string,
  entities: Entity[],
): Promise<DefinedTerm[]> => {
  const definitionPatterns = await getDefinitionPatterns();
  const terms: DefinedTerm[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const windowStart = Math.max(0, entity.start - SEARCH_WINDOW);
    const windowEnd = Math.min(fullText.length, entity.end + SEARCH_WINDOW);
    const window = fullText.slice(windowStart, windowEnd);

    for (const { pattern } of definitionPatterns) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(window);
        match !== null;
        match = pattern.exec(window)
      ) {
        const alias = match[1]?.trim();
        if (!alias || alias.length < 2) {
          continue;
        }

        const key = `${alias.toLowerCase()}::${entity.label}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        terms.push({
          alias,
          label: entity.label,
          definitionStart: windowStart + match.index,
        });
      }
    }
  }

  return terms;
};

/**
 * Find all occurrences of defined-term aliases in the
 * full text. Returns Entity spans for each match.
 *
 * Simple string search (no fuzzy matching); defined terms
 * are typically exact in legal documents.
 */
export const findCoreferenceSpans = (
  fullText: string,
  terms: DefinedTerm[],
): Entity[] => {
  const results: Entity[] = [];

  for (const term of terms) {
    let searchFrom = 0;
    while (searchFrom < fullText.length) {
      const idx = fullText.indexOf(term.alias, searchFrom);
      if (idx === -1) {
        break;
      }

      results.push({
        start: idx,
        end: idx + term.alias.length,
        label: term.label,
        text: term.alias,
        score: 0.95,
        source: DETECTION_SOURCES.COREFERENCE,
      });

      searchFrom = idx + term.alias.length;
    }
  }

  return results;
};
