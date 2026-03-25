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
 * Characters that act as hard stops when scanning
 * backward for a word boundary. Entity boundaries
 * should never extend past these.
 */
const WORD_START_STOPS = new Set([
  "\n", "\r", ",", ";", "(", ")", "[", "]",
]);

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
    const prev = text[p - 1];
    if (
      prev !== undefined &&
      WORD_START_STOPS.has(prev)
    ) {
      return p;
    }
    p--;
  }
  return p;
};

/**
 * Characters that act as hard stops when scanning
 * forward for a word boundary. Entity boundaries
 * should never extend past these.
 */
const WORD_END_STOPS = new Set([
  "\n", "\r", ",", ";", ".", "(", ")", "[", "]",
]);

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
    const ch = text[p];
    if (ch !== undefined && WORD_END_STOPS.has(ch)) {
      return p;
    }
    p++;
  }
  return p;
};

/**
 * Binary search: find the leftmost index in `arr`
 * where `arr[index].start >= value`.
 */
const lowerBound = (
  arr: Entity[],
  value: number,
): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const el = arr[mid];
    if (el && el.start < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
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
 *
 * Uses binary search for the `gapOccupied` check and
 * a Map for O(1) same-label prev lookup. O(n log n).
 */
const mergeAdjacent = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const sorted = entities.toSorted(
    (a, b) => a.start - b.start,
  );
  const result: Entity[] = [];
  // O(1) lookup for the last same-label entity in
  // result, replacing the O(n) backward scan.
  const lastByLabel = new Map<string, Entity>();

  for (const entity of sorted) {
    const prev = lastByLabel.get(entity.label);

    if (!prev) {
      const copy = { ...entity };
      result.push(copy);
      lastByLabel.set(entity.label, copy);
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
    // overlap). Use binary search to find candidates
    // in the gap range instead of scanning all entities.
    const gapStart = prev.end;
    const gapEnd = entity.start;
    const searchIdx = lowerBound(sorted, gapStart);
    let gapOccupied = false;
    for (let k = searchIdx; k < sorted.length; k++) {
      const other = sorted[k];
      if (!other || other.start >= gapEnd) break;
      if (
        other.label !== entity.label &&
        other.end > gapStart
      ) {
        gapOccupied = true;
        break;
      }
    }

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
      const copy = { ...entity };
      result.push(copy);
      lastByLabel.set(entity.label, copy);
    }
  }

  return result;
};

/**
 * Fix partial-word boundaries by extending entity
 * start/end to the nearest word boundary. Does not
 * extend across newlines or into spans occupied by
 * different-label entities.
 *
 * Uses binary search to skip irrelevant entries when
 * clamping at cross-label neighbors. O(n log n) in
 * the common case; O(n^2) worst case when many
 * same-label entities precede a cross-label boundary.
 */
const fixPartialWords = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  const boundaries = buildWordBoundaries(fullText);
  const sorted = entities.toSorted(
    (a, b) => a.start - b.start,
  );

  // Build a secondary array sorted by end position
  // for efficient "nearest entity ending before me"
  // lookups. Each entry tracks the original entity.
  const byEnd = sorted
    .map((e, idx) => ({ entity: e, idx }))
    .sort((a, b) => a.entity.end - b.entity.end);
  const endPositions = byEnd.map((x) => x.entity.end);

  return sorted.map((e, eIdx) => {
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

    // Clamp start: find different-label entities whose
    // end is in (newStart, e.start]. We search byEnd
    // for entities with end > newStart and end <= e.start.
    // Binary search for the first entry with
    // end > newStart.
    let lo = 0;
    let hi = endPositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (
        (endPositions[mid] ?? Number.POSITIVE_INFINITY) <=
        newStart
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // Scan forward from lo; all entries have end >
    // newStart. Stop when end > e.start.
    for (let k = lo; k < byEnd.length; k++) {
      const entry = byEnd[k];
      if (!entry || entry.entity.end > e.start) break;
      if (entry.idx === eIdx) continue;
      if (entry.entity.label === e.label) continue;
      // This entity's end is in (newStart, e.start]
      // and has a different label: clamp.
      newStart = Math.max(
        newStart,
        entry.entity.end,
      );
    }

    // Clamp end: find different-label entities whose
    // start is in [e.end, newEnd). Use the start-sorted
    // array with binary search.
    const startIdx = lowerBound(sorted, e.end);
    for (let k = startIdx; k < sorted.length; k++) {
      const other = sorted[k];
      if (!other || other.start >= newEnd) break;
      if (other === e) continue;
      if (other.label === e.label) continue;
      // This entity's start is in [e.end, newEnd)
      // and has a different label: clamp.
      newEnd = Math.min(newEnd, other.start);
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
 *
 * Uses a "max end seen" sweep per label. O(n) after
 * the initial sort.
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
  // Track the furthest end seen per label. Any entity
  // whose end <= maxEnd for its label is nested inside
  // a previously seen entity of the same label.
  const maxEndByLabel = new Map<string, number>();

  for (const entity of sorted) {
    const maxEnd = maxEndByLabel.get(entity.label);
    if (
      maxEnd !== undefined &&
      entity.end <= maxEnd
    ) {
      // Nested inside a same-label entity: skip.
      continue;
    }
    maxEndByLabel.set(entity.label, entity.end);
    result.push(entity);
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
 *
 * Preserved existing structure: sorted + early break
 * already gives good amortized behavior. O(n^2)
 * worst case but rare in practice.
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
      if (!a || !b) continue;
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
        // array is sorted by start and a.end can
        // only decrease, all remaining j will have
        // b.start >= a.end so the break fires
        // immediately.
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
