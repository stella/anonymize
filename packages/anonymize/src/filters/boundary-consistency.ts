import type { Entity } from "../types";

/** Max gap (in chars) between entities to merge. */
const MAX_GAP = 3;

/**
 * Characters allowed in the gap between two adjacent
 * same-label entities that should be merged.
 */
const GAP_PATTERN = /^[\s,\-]+$/;

/**
 * Build a set of word boundary offsets for the full
 * text using `Intl.Segmenter`. Returns a sorted array
 * of offsets where words start and end.
 */
const buildWordBoundaries = (
  text: string,
): Set<number> => {
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "word",
  });
  const boundaries = new Set<number>();
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    boundaries.add(seg.index);
    boundaries.add(seg.index + seg.segment.length);
  }
  return boundaries;
};

/**
 * Find the word-start offset at or before `pos`.
 * Scans left until a word boundary is found.
 */
const wordStartAt = (
  pos: number,
  boundaries: Set<number>,
  text: string,
): number => {
  let p = pos;
  while (p > 0 && !boundaries.has(p)) {
    // Don't cross newlines
    if (text[p - 1] === "\n") return p;
    p--;
  }
  return p;
};

/**
 * Find the word-end offset at or after `pos`.
 * Scans right until a word boundary is found.
 */
const wordEndAt = (
  pos: number,
  boundaries: Set<number>,
  text: string,
): number => {
  let p = pos;
  while (p < text.length && !boundaries.has(p)) {
    // Don't cross newlines
    if (text[p] === "\n") return p;
    p++;
  }
  return p;
};

/**
 * Step 1: merge adjacent same-label entities separated
 * only by whitespace, comma, or hyphen (max 3 chars).
 */
const mergeAdjacent = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const sorted = entities.toSorted(
    (a, b) => a.start - b.start,
  );
  const result: Entity[] = [];

  for (const entity of sorted) {
    const prev = result.at(-1);
    if (!prev || prev.label !== entity.label) {
      result.push({ ...entity });
      continue;
    }

    const gap = fullText.slice(prev.end, entity.start);
    // GAP_PATTERN uses `+` quantifier, so empty gaps
    // (zero-gap / touching entities) won't match.
    if (
      gap.length <= MAX_GAP &&
      GAP_PATTERN.test(gap)
    ) {
      // Merge into prev
      prev.end = entity.end;
      prev.text = fullText.slice(prev.start, prev.end);
      prev.score = Math.max(prev.score, entity.score);
    } else {
      result.push({ ...entity });
    }
  }

  return result;
};

/**
 * Step 2: fix partial-word boundaries by extending
 * entity start/end to the nearest word boundary.
 * Does not extend across newlines.
 */
const fixPartialWords = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const boundaries = buildWordBoundaries(fullText);

  return entities.map((e) => {
    const newStart = wordStartAt(
      e.start,
      boundaries,
      fullText,
    );
    const newEnd = wordEndAt(
      e.end,
      boundaries,
      fullText,
    );
    if (newStart === e.start && newEnd === e.end) {
      return e;
    }
    return {
      ...e,
      start: newStart,
      end: newEnd,
      text: fullText.slice(newStart, newEnd),
    };
  });
};

/**
 * Deduplicate entities with identical [start, end, label].
 * Keeps the entry with the highest score.
 */
const deduplicateSpans = (
  entities: Entity[],
): Entity[] => {
  const seen = new Map<string, Entity>();
  for (const entity of entities) {
    const key =
      `${entity.start}:${entity.end}:${entity.label}`;
    const existing = seen.get(key);
    if (
      !existing ||
      entity.score > existing.score
    ) {
      seen.set(key, entity);
    }
  }
  return [...seen.values()];
};

/**
 * Step 3: remove nested same-label entities. If a
 * shorter entity is fully contained within a longer
 * entity of the same label, drop the shorter one.
 */
const removeNestedSameLabel = (
  entities: Entity[],
): Entity[] => {
  // Sort by start asc, then by length desc so the
  // longer entity comes first.
  const sorted = entities.toSorted((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const result: Entity[] = [];
  for (const entity of sorted) {
    const isNested = result.some(
      (outer) =>
        outer.label === entity.label &&
        outer.start <= entity.start &&
        outer.end >= entity.end &&
        outer !== entity,
    );
    if (!isNested) {
      result.push(entity);
    }
  }

  return result;
};

/**
 * Post-processing pass for entity boundary consistency.
 * Runs after mergeAndDedup, before false-positive
 * filtering.
 *
 * 1. Fix partial-word boundaries (may create overlaps)
 * 2. Deduplicate identical [start, end, label] spans
 * 3. Merge adjacent same-label entities (catches any
 *    new adjacency/overlap from step 1)
 * 4. Remove nested same-label entities
 */
export const enforceBoundaryConsistency = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const fixed = fixPartialWords(entities, fullText);
  const deduped = deduplicateSpans(fixed);
  const merged = mergeAdjacent(deduped, fullText);
  return removeNestedSameLabel(merged);
};
