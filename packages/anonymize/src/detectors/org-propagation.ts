import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

/**
 * Known legal form suffixes to strip when extracting
 * the base organization name. Ordered longest-first
 * so "spol. s r.o." matches before "s.r.o.".
 */
const LEGAL_SUFFIXES = [
  "spol. s r.o.",
  "s.r.o.",
  "s. r. o.",
  "a.s.",
  "a. s.",
  "v.o.s.",
  "v. o. s.",
  "k.s.",
  "k. s.",
  "z.s.",
  "z. s.",
  "z.ú.",
  "z. ú.",
  "o.p.s.",
  "o. p. s.",
  "s.p.",
  "s. p.",
  "GmbH",
  "AG",
  "SE",
  "KG",
  "OHG",
  "Ltd.",
  "Ltd",
  "LLC",
  "LLP",
  "Inc.",
  "S.A.",
  "SA",
  "SAS",
  "SARL",
  "Sp. z o.o.",
  "S.p.A.",
];

const TRAILING_SEP = /[,\s]+$/;
const LETTER_RE = /\p{L}/u;
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

  // Build a set of already-covered spans for fast
  // overlap checks.
  const covered = entities.map(
    (e) => [e.start, e.end] as const,
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
      // by a letter (prevents substring matches).
      const prevCh = fullText[idx - 1] ?? "";
      const nextCh = fullText[matchEnd] ?? "";
      if (
        LETTER_RE.test(prevCh) ||
        LETTER_RE.test(nextCh)
      ) {
        searchFrom = idx + 1;
        continue;
      }

      // Skip if already covered by an existing entity
      if (!isOverlapping(idx, matchEnd)) {
        results.push({
          start: idx,
          end: matchEnd,
          label,
          text: baseName,
          score: ORG_PROPAGATION_SCORE,
          source: DETECTION_SOURCES.COREFERENCE,
        });
      }

      searchFrom = matchEnd;
    }
  }

  return results;
};
