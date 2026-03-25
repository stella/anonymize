import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import { LEGAL_SUFFIXES } from "../config/legal-forms";

const TRAILING_SEP = /[,\s]+$/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const ORG_PROPAGATION_SCORE = 0.9;

type Seed = {
  baseName: string;
  label: string;
};

/**
 * After the main detection pass, collect organization
 * entities with a legal form suffix, strip the suffix
 * to get the base name, and re-scan the full text for
 * bare mentions of that base name. Returns new entities
 * for occurrences not already covered.
 */
export const propagateOrgNames = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const seeds: Seed[] = [];
  const seenBases = new Set<string>();

  for (const e of entities) {
    if (e.label !== "organization") continue;
    for (const suffix of LEGAL_SUFFIXES) {
      if (e.text.endsWith(suffix)) {
        const base = e.text
          .slice(0, -suffix.length)
          .replace(TRAILING_SEP, "")
          .trim();
        if (base.length >= 3 && !seenBases.has(base)) {
          seenBases.add(base);
          seeds.push({
            baseName: base,
            label: e.label,
          });
        }
        break;
      }
    }
  }

  if (seeds.length === 0) return [];

  // Build a mutable array of already-covered spans
  // for overlap checks. Updated as new entities are
  // emitted to prevent duplicate propagation.
  const covered: [number, number][] = entities.map(
    (e) => [e.start, e.end],
  );
  const isOverlapping = (
    start: number,
    end: number,
  ): boolean =>
    covered.some(
      ([cs, ce]) => start < ce && end > cs,
    );

  const results: Entity[] = [];

  for (const seed of seeds) {
    const { baseName, label } = seed;
    let searchFrom = 0;
    while (searchFrom < fullText.length) {
      const idx = fullText.indexOf(
        baseName,
        searchFrom,
      );
      if (idx === -1) break;

      const matchEnd = idx + baseName.length;

      // Word boundary: reject if preceded or followed
      // by a letter or digit (prevents substring
      // matches like "ACME" inside "ACME2").
      const prevCh = fullText[idx - 1] ?? "";
      const nextCh = fullText[matchEnd] ?? "";
      if (
        WORD_CHAR_RE.test(prevCh) ||
        WORD_CHAR_RE.test(nextCh)
      ) {
        searchFrom = idx + 1;
        continue;
      }

      // Skip if already covered by an existing entity
      // or a previously propagated result.
      if (!isOverlapping(idx, matchEnd)) {
        results.push({
          start: idx,
          end: matchEnd,
          label,
          text: baseName,
          score: ORG_PROPAGATION_SCORE,
          source: DETECTION_SOURCES.COREFERENCE,
        });
        covered.push([idx, matchEnd]);
      }

      searchFrom = matchEnd;
    }
  }

  return results;
};
