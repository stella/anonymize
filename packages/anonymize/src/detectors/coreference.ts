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

/**
 * Load generic role terms that should NOT be treated
 * as PII coreferences. "Prodávající" (Seller),
 * "Kupující" (Buyer), etc. are legal roles, not
 * identifying information.
 */
let _roleStopSet: Set<string> | null = null;

const getRoleStopSet = async (): Promise<Set<string>> => {
  if (_roleStopSet) {
    return _roleStopSet;
  }
  try {
    const mod = await import(
      "@stll/anonymize-data/config/generic-roles.json"
    );
    const data = (mod.default ?? mod) as {
      roles: string[];
    };
    _roleStopSet = new Set(
      data.roles.map((r: string) => r.toLowerCase()),
    );
  } catch {
    _roleStopSet = new Set();
  }
  return _roleStopSet;
};

let _cachedPatterns: DefinitionPattern[] | null = null;
let _cachedPatternsPromise: Promise<
  DefinitionPattern[]
> | null = null;
let _loadAttempted = false;

const getDefinitionPatterns =
  async (): Promise<DefinitionPattern[]> => {
    if (_cachedPatterns) {
      return _cachedPatterns;
    }
    if (_cachedPatternsPromise) {
      return _cachedPatternsPromise;
    }
    _cachedPatternsPromise = loadDefinitionPatterns();
    const patterns = await _cachedPatternsPromise;
    if (patterns.length === 0) {
      // All loads failed; cache empty array permanently
      // to avoid retrying dynamic imports and flooding
      // logs on every call in high-volume pipelines.
      _cachedPatterns = patterns;
      if (!_loadAttempted) {
        _loadAttempted = true;
        console.warn(
          "[anonymize] coreference: no definition " +
            "patterns loaded; coreference detection " +
            "will be inactive",
        );
      }
      return patterns;
    }
    _cachedPatterns = patterns;
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
/**
 * Labels that can be the source of a coreference alias.
 * Only parties (person, organization) have defined-term
 * aliases in legal text. Dates, addresses, IDs do not.
 */
const COREF_SOURCE_LABELS = new Set([
  "person",
  "organization",
]);

export const extractDefinedTerms = async (
  fullText: string,
  entities: Entity[],
): Promise<DefinedTerm[]> => {
  const [definitionPatterns, roleStops] =
    await Promise.all([
      getDefinitionPatterns(),
      getRoleStopSet(),
    ]);
  const terms: DefinedTerm[] = [];
  const seen = new Set<string>();

  // Sort entities by position for nearest-preceding lookup
  const sorted = [...entities].sort(
    (a, b) => a.start - b.start,
  );

  // Strategy: find all "dále jen" definitions in the
  // text, then for each one, find the nearest PRECEDING
  // person/organization entity. This is more accurate
  // than "any entity within 200 chars" because:
  // - The alias always refers to a party defined BEFORE
  //   the parenthetical, not after
  // - Multiple entities (name, IČO, address) may appear
  //   between the party name and the "dále jen"; only
  //   the party name is the referent

  for (const { pattern } of definitionPatterns) {
    pattern.lastIndex = 0;

    for (
      let match = pattern.exec(fullText);
      match !== null;
      match = pattern.exec(fullText)
    ) {
      const alias = match[1]?.trim();
      if (!alias || alias.length < 2) {
        continue;
      }

      // Skip generic legal roles — "Prodávající",
      // "Kupující", "Seller", etc. are NOT PII.
      // Only track aliases that are themselves
      // identifying (initials, name fragments, etc.)
      if (roleStops.has(alias.toLowerCase())) {
        continue;
      }

      const defPos = match.index;

      // Find the nearest preceding person/org entity
      // within SEARCH_WINDOW chars before this definition
      let bestEntity: Entity | null = null;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const e = sorted[i];
        if (e === undefined) {
          continue;
        }
        // Must be before the definition
        if (e.end > defPos) {
          continue;
        }
        // Must be within the search window
        if (defPos - e.end > SEARCH_WINDOW) {
          break;
        }
        // Must be a party label
        if (!COREF_SOURCE_LABELS.has(e.label)) {
          continue;
        }
        bestEntity = e;
        break;
      }

      if (bestEntity === null) {
        continue;
      }

      const key = `${alias.toLowerCase()}::${bestEntity.label}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      terms.push({
        alias,
        label: bestEntity.label,
        definitionStart: defPos,
      });
    }
  }

  return terms;
};

/**
 * Check if a character is a Unicode word character
 * (letter, digit, or combining mark). Used for word
 * boundary checks in coreference matching.
 */
const isWordChar = (ch: string | undefined): boolean => {
  if (ch === undefined) {
    return false;
  }
  return /[\p{L}\p{M}\p{N}]/u.test(ch);
};

/**
 * Find all occurrences of defined-term aliases in the
 * full text. Returns Entity spans for each match.
 *
 * Respects word boundaries: "Kupující" must not match
 * inside "Kupujícímu". A match is valid only if the
 * character before the start and after the end are NOT
 * word characters (letter/digit).
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

      const matchEnd = idx + term.alias.length;

      // Word boundary check: the character before the
      // match and after the match must not be a word
      // character. This prevents "Kupující" matching
      // inside "Kupujícímu".
      const charBefore = idx > 0
        ? fullText[idx - 1]
        : undefined;
      const charAfter = fullText[matchEnd];

      if (isWordChar(charBefore) || isWordChar(charAfter)) {
        // Not at a word boundary — skip
        searchFrom = idx + 1;
        continue;
      }

      results.push({
        start: idx,
        end: matchEnd,
        label: term.label,
        text: term.alias,
        score: 0.95,
        source: DETECTION_SOURCES.COREFERENCE,
      });

      searchFrom = matchEnd;
    }
  }

  return results;
};
