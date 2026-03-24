import type { Entity } from "../types";

/** Max gap (in chars) between entities to merge. */
const MAX_GAP = 3;

/**
 * Characters allowed in the gap between two adjacent
 * same-label entities that should be merged: spaces,
 * tabs, commas, and hyphens. Uses `[ \t,\-]` instead
 * of `\s` to avoid merging entities across newlines.
 */
const GAP_PATTERN = /^[ \t,\-]+$/;

/**
 * Build a set of word boundary offsets for the full
 * text using `Intl.Segmenter`. Returns a sorted array
 * of offsets where words start and end.
 */
const buildWordBoundaries = (
  text: string,
): Set<number> => {
  // Use "und" (undetermined) locale for consistent
  // word-boundary results across environments.
  const segmenter = new Intl.Segmenter("und", {
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
    // Don't cross newlines (LF or CR)
    const prev = text[p - 1];
    if (prev === "\n" || prev === "\r") return p;
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
    // Don't cross newlines (LF or CR)
    const ch = text[p];
    if (ch === "\n" || ch === "\r") return p;
    p++;
  }
  return p;
};

/**
 * Merge adjacent same-label entities separated only by
 * whitespace, comma, or hyphen (max 3 chars). Also
 * merges same-label entities that partially overlap
 * (which can happen after word-boundary expansion).
 *
 * Looks for the last same-label entity in the result
 * (not just the very last entity) so that an
 * intervening different-label entity does not prevent
 * merging.
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
    // Find the last same-label entity in result.
    let prev: Entity | undefined;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i]?.label === entity.label) {
        prev = result[i];
        break;
      }
    }

    if (!prev) {
      result.push({ ...entity });
      continue;
    }

    // Handle overlap created by fixPartialWords:
    // two same-label entities may now partially overlap
    // after word-boundary expansion.
    if (entity.start < prev.end) {
      prev.end = Math.max(prev.end, entity.end);
      prev.text = fullText.slice(prev.start, prev.end);
      prev.score = Math.max(prev.score, entity.score);
      continue;
    }

    const gap = fullText.slice(prev.end, entity.start);
    // GAP_PATTERN uses `+` quantifier, so empty gaps
    // (zero-gap / touching entities) won't match.
    // Also reject merging when a different-label entity
    // occupies the gap range (would create cross-label
    // overlap). Correctness relies on fixPartialWords
    // clamping expansion at cross-label neighbors so
    // that the input to this function has no cross-label
    // overlaps.
    const gapOccupied = sorted.some(
      (other) =>
        other.label !== entity.label &&
        other.start >= prev.end &&
        other.start < entity.start &&
        other.end > prev.end,
    );
    if (
      !gapOccupied &&
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
 * Fix partial-word boundaries by extending entity
 * start/end to the nearest word boundary. Does not
 * extend across newlines or into spans occupied by
 * different-label entities.
 */
const fixPartialWords = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const boundaries = buildWordBoundaries(fullText);
  const sorted = entities.toSorted(
    (a, b) => a.start - b.start,
  );

  return sorted.map((e) => {
    let newStart = wordStartAt(
      e.start,
      boundaries,
      fullText,
    );
    let newEnd = wordEndAt(
      e.end,
      boundaries,
      fullText,
    );

    // Don't expand into a different-label neighbor's
    // span. Check the previous and next entities.
    for (const other of sorted) {
      if (other === e) continue;
      if (other.label === e.label) continue;
      // Clamp start: don't expand left past a
      // different-label entity's end.
      if (
        other.end > newStart &&
        other.end <= e.start
      ) {
        newStart = Math.max(newStart, other.end);
      }
      // Clamp end: don't expand right past a
      // different-label entity's start.
      if (
        other.start < newEnd &&
        other.start >= e.end
      ) {
        newEnd = Math.min(newEnd, other.start);
      }
    }

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
 * Remove nested same-label entities. If a shorter
 * entity is fully contained within a longer entity
 * of the same label, drop the shorter one.
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
 * Resolve cross-label overlaps that can arise when
 * `fixPartialWords` independently expands two
 * different-label entities toward the same word
 * boundary. The entity with the higher score (or
 * longer span on tie) keeps its boundary; the other
 * is trimmed so the overlap disappears.
 */
const resolveCrossLabelOverlaps = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const sorted = entities
    .map((e) => ({ ...e }))
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.start >= a.end) break; // no overlap
      if (a.label === b.label) continue;

      // Skip full containment (one entity fully
      // inside another). Cross-label nesting is
      // valid and should be preserved.
      const aContainsB =
        a.start <= b.start && a.end >= b.end;
      const bContainsA =
        b.start <= a.start && b.end >= a.end;
      if (aContainsB || bContainsA) continue;

      // Partial overlap. Higher score wins; on tie
      // the longer span wins.
      const aLen = a.end - a.start;
      const bLen = b.end - b.start;
      const aWins =
        a.score > b.score ||
        (a.score === b.score && aLen >= bLen);

      if (aWins) {
        // Trim b's start to a's end
        b.start = a.end;
        b.text = fullText.slice(b.start, b.end);
      } else {
        // Trim a's end to b's start. Because the
        // array is sorted by start and a.end can only
        // decrease, all remaining j will have
        // b.start >= a.end so the break fires
        // immediately: a no longer overlaps any later
        // entity.
        a.end = b.start;
        a.text = fullText.slice(a.start, a.end);
      }
    }
  }

  // Drop any entity that was trimmed to zero width.
  return sorted.filter((e) => e.start < e.end);
};

/**
 * Post-processing pass for entity boundary consistency.
 * Runs after mergeAndDedup, before false-positive
 * filtering.
 *
 * 1. Fix partial-word boundaries (respects cross-label
 *    neighbors to avoid introducing new overlaps)
 * 2. Resolve any remaining cross-label overlaps
 * 3. Deduplicate identical [start, end, label] spans
 * 4. Merge adjacent same-label entities (catches any
 *    new adjacency/overlap from step 1)
 * 5. Remove nested same-label entities
 */
export const enforceBoundaryConsistency = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const fixed = fixPartialWords(entities, fullText);
  const resolved = resolveCrossLabelOverlaps(
    fixed,
    fullText,
  );
  const deduped = deduplicateSpans(resolved);
  const merged = mergeAdjacent(deduped, fullText);
  return removeNestedSameLabel(merged);
};
