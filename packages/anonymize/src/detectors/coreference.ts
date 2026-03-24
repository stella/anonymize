import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import type {
  DefinitionPattern,
  PipelineContext,
} from "../context";
import { defaultContext } from "../context";
import {
  loadLanguageConfigs,
} from "../util/lang-loader";

type CoreferenceConfigRow = {
  pattern: string;
  flags: string;
  label: string;
};

/**
 * Load coreference definition patterns from per-language
 * JSON configs in @stll/anonymize-data. Uses the
 * language manifest for auto-discovery.
 */
const loadDefinitionPatterns =
  async (): Promise<DefinitionPattern[]> => {
    const patterns: DefinitionPattern[] = [];

    const allRows = await loadLanguageConfigs<
      readonly CoreferenceConfigRow[]
    >(
      "coreference",
      (mod) => {
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
        const m = mod as {
          default?: readonly CoreferenceConfigRow[];
        };
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON config
        return (m.default ?? mod) as
          readonly CoreferenceConfigRow[];
      },
    );

    for (const rows of allRows) {
      if (!Array.isArray(rows)) {
        console.warn(
          "[anonymize] coreference: unexpected " +
            "config shape, skipping",
        );
        continue;
      }
      for (const row of rows) {
        try {
          patterns.push({
            pattern: new RegExp(row.pattern, row.flags),
          });
        } catch (err) {
          console.warn(
            `[anonymize] coreference: invalid ` +
              `regex "${row.pattern}":`,
            err,
          );
        }
      }
    }

    return patterns;
  };

/**
 * Load generic role terms that should NOT be treated
 * as PII coreferences. "Prodávající" (Seller),
 * "Kupující" (Buyer), etc. are legal roles, not
 * identifying information.
 */
const getRoleStopSet = async (
  ctx: PipelineContext,
): Promise<ReadonlySet<string>> => {
  if (ctx.roleStopSet) return ctx.roleStopSet;
  if (ctx.roleStopSetPromise) return ctx.roleStopSetPromise;
  const promise = (async () => {
    let result: ReadonlySet<string>;
    try {
      const mod = await import(
        "@stll/anonymize-data/config/generic-roles.json"
      );
      const data = (mod.default ?? mod) as {
        roles: string[];
      };
      result = new Set(
        data.roles.map((r: string) => r.toLowerCase()),
      );
    } catch {
      result = new Set();
    }
    ctx.roleStopSet = result;
    return result;
  })();
  ctx.roleStopSetPromise = promise;
  return promise;
};

const getDefinitionPatterns = async (
  ctx: PipelineContext,
): Promise<DefinitionPattern[]> => {
  if (ctx.corefPatterns) {
    return ctx.corefPatterns;
  }
  if (ctx.corefPatternsPromise) {
    return ctx.corefPatternsPromise;
  }
  ctx.corefPatternsPromise = loadDefinitionPatterns();
  const patterns = await ctx.corefPatternsPromise;
  if (patterns.length === 0) {
    // All loads failed; cache empty array permanently
    // to avoid retrying dynamic imports and flooding
    // logs on every call in high-volume pipelines.
    ctx.corefPatterns = patterns;
    if (!ctx.corefLoadAttempted) {
      ctx.corefLoadAttempted = true;
      console.warn(
        "[anonymize] coreference: no definition " +
          "patterns loaded; coreference detection " +
          "will be inactive",
      );
    }
    return patterns;
  }
  ctx.corefPatterns = patterns;
  return patterns;
};

const SEARCH_WINDOW = 200;

type DefinedTerm = {
  alias: string;
  label: string;
  /** Position of the definition in the source text */
  definitionStart: number;
  /** Original entity text the alias refers to */
  sourceText: string;
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
  ctx: PipelineContext = defaultContext,
): Promise<DefinedTerm[]> => {
  const [definitionPatterns, roleStops] =
    await Promise.all([
      getDefinitionPatterns(ctx),
      getRoleStopSet(ctx),
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
        sourceText: bestEntity.text,
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
 * Side-channel mapping from coreference entity →
 * source entity text. Used by buildPlaceholderMap to
 * assign the same placeholder number to an alias and
 * its source entity (e.g., "TP" → "Ing. Tomáš
 * Procházka" both become [PERSON_1]).
 *
 * Populated by findCoreferenceSpans, consumed by
 * buildPlaceholderMap. Cleared on each call to
 * findCoreferenceSpans.
 */
export const corefSourceMap = new WeakMap<
  Entity,
  string
>();

/**
 * Find all occurrences of defined-term aliases in the
 * full text. Returns Entity spans for each match.
 *
 * Respects word boundaries: "Kupující" must not match
 * inside "Kupujícímu". A match is valid only if the
 * character before the start and after the end are NOT
 * word characters (letter/digit).
 *
 * Populates the module-level `corefSourceMap` WeakMap
 * with entries linking each coref entity to its source
 * entity text, for consistent placeholder numbering.
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

      const entity: Entity = {
        start: idx,
        end: matchEnd,
        label: term.label,
        text: term.alias,
        score: 0.95,
        source: DETECTION_SOURCES.COREFERENCE,
      };
      corefSourceMap.set(entity, term.sourceText);
      results.push(entity);

      searchFrom = matchEnd;
    }
  }

  return results;
};
