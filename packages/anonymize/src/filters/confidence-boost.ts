import type { Entity } from "../types";

const NEAR_MISS_BAND = 0.15;
const BOOST_PER_NEIGHBOUR = 0.05;
const CONTEXT_WINDOW_CHARS = 150;
const HIGH_CONFIDENCE_FLOOR = 0.9;

/**
 * Boost confidence of near-miss NER entities that appear
 * near high-confidence detections (regex, trigger phrase).
 *
 * If an NER entity scored between (threshold - 0.15) and
 * threshold, count how many confirmed entities exist within
 * a 150-char window. Add +0.05 per co-located entity.
 * If the boosted score crosses the threshold, include it.
 *
 * Only mutates score on near-miss entities; high-confidence
 * entities pass through unchanged.
 */
export const boostNearMissEntities = (
  entities: Entity[],
  threshold: number,
): Entity[] => {
  const nearMissBand = Math.max(0, threshold - NEAR_MISS_BAND);
  const confirmed = entities.filter((e) => e.score >= HIGH_CONFIDENCE_FLOOR);

  const boosted: Entity[] = [];

  for (const entity of entities) {
    if (entity.score >= threshold) {
      boosted.push(entity);
      continue;
    }

    if (entity.score < nearMissBand) {
      continue;
    }

    const midpoint = (entity.start + entity.end) / 2;
    let neighbourCount = 0;

    for (const anchor of confirmed) {
      const anchorMid = (anchor.start + anchor.end) / 2;
      if (Math.abs(midpoint - anchorMid) <= CONTEXT_WINDOW_CHARS) {
        neighbourCount++;
      }
    }

    const boostedScore = entity.score + neighbourCount * BOOST_PER_NEIGHBOUR;

    if (boostedScore >= threshold) {
      boosted.push({ ...entity, score: boostedScore });
    }
  }

  return boosted;
};

// ── Street address pattern near address entities ────

const STREET_PATTERN_RE =
  /\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*\s+\d+(?:\/\d+[a-zA-Z]?)?/gu;

const STREET_CONTEXT_WINDOW = 200;

/**
 * Find street-like patterns (Titlecase + house number)
 * that appear near existing address entities. These
 * patterns are too ambiguous to detect alone but are
 * reliable when adjacent to a known address (PSČ, city).
 *
 * Example: "Ostrovní 225/1" near "110 00 Praha 1"
 */
export const detectStreetPatternsNearAddresses = (
  fullText: string,
  existingEntities: Entity[],
): Entity[] => {
  const addressEntities = existingEntities.filter(
    (e) => e.label === "address",
  );
  if (addressEntities.length === 0) {
    return [];
  }

  const results: Entity[] = [];
  STREET_PATTERN_RE.lastIndex = 0;

  for (
    let m = STREET_PATTERN_RE.exec(fullText);
    m !== null;
    m = STREET_PATTERN_RE.exec(fullText)
  ) {
    const start = m.index;
    const end = start + m[0].length;

    // Skip if already covered by an existing entity
    if (
      existingEntities.some(
        (e) => e.start <= start && e.end >= end,
      )
    ) {
      continue;
    }

    // Check if near an address entity
    const nearAddress = addressEntities.some(
      (e) =>
        Math.abs(e.start - end) < STREET_CONTEXT_WINDOW ||
        Math.abs(e.end - start) < STREET_CONTEXT_WINDOW,
    );

    if (nearAddress) {
      results.push({
        start,
        end,
        label: "address",
        text: m[0],
        score: 0.8,
        source: "regex",
      });
    }
  }

  return results;
};
