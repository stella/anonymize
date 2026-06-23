import type { Entity } from "../types";

const MAX_CHUNK_CHARS = 1500;
const OVERLAP_CHARS = 50;
const MIN_CHUNK_LENGTH = 10;

/** A chunk paired with its start offset in the source text. */
export type ChunkSpan = { text: string; offset: number };

/**
 * Split text into overlapping chunks, each paired with its
 * exact start offset in the source text.
 *
 * Carrying the offset out of the splitter is the robust way to
 * map chunk-local entity offsets back to document offsets:
 * downstream code never has to re-locate a chunk by content
 * search (which mis-locates when boilerplate repeats; see
 * computeChunkOffsets).
 *
 * Character-based splitting (rough token approximation for
 * GLiNER's ~512 token window); breaks at sentence boundaries
 * when possible.
 */
export const chunkTextWithOffsets = (text: string): ChunkSpan[] => {
  const chunks: ChunkSpan[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + MAX_CHUNK_CHARS, text.length);

    if (end < text.length) {
      const slice = text.slice(offset, end);
      const lastPeriod = slice.lastIndexOf(". ");
      if (lastPeriod > MAX_CHUNK_CHARS * 0.5) {
        end = offset + lastPeriod + 2;
      }
    }

    const chunk = text.slice(offset, end);
    if (chunk.trim().length > MIN_CHUNK_LENGTH) {
      chunks.push({ text: chunk, offset });
    }
    if (end === text.length) {
      break;
    }
    offset = Math.max(offset + 1, end - OVERLAP_CHARS);
  }

  return chunks;
};

/**
 * Split text into overlapping chunks for GLiNER's ~512 token
 * context window. Character-based splitting (rough token
 * approximation); breaks at sentence boundaries when possible.
 *
 * Prefer chunkTextWithOffsets when you also need each chunk's
 * document offset.
 */
export const chunkText = (text: string): string[] =>
  chunkTextWithOffsets(text).map((chunk) => chunk.text);

/**
 * Compute the start offset of each chunk within the original
 * document text by content search.
 *
 * @deprecated Re-locates each chunk with `indexOf`, which can
 *   match the wrong position when identical content repeats in
 *   the document (common in boilerplate-heavy legal text) and
 *   then desyncs every subsequent offset. Use
 *   `chunkTextWithOffsets`, which carries exact offsets out of
 *   the splitter.
 */
export const computeChunkOffsets = (
  fullText: string,
  chunks: string[],
): number[] => {
  const offsets: number[] = [];
  let searchFrom = 0;

  for (const chunk of chunks) {
    const idx = fullText.indexOf(chunk, searchFrom);
    offsets.push(idx !== -1 ? idx : searchFrom);
    searchFrom =
      idx !== -1 ? idx + Math.max(1, chunk.length - OVERLAP_CHARS) : searchFrom;
  }

  return offsets;
};

const POSITION_THRESHOLD = 5;

/**
 * Merge entities from overlapping chunks back to
 * document-level offsets. Deduplicates entities that
 * appear in overlap regions (keeps highest score).
 *
 * Dedup invariant: each incoming entity is compared
 * against the highest-scored same-label near-dup in
 * its proximity window. If it loses, it is dropped.
 * This does NOT guarantee that all pairwise near-dup
 * relationships in the output are resolved; a lower-
 * scored entity can survive if the bridging entity
 * that would have replaced it was itself dropped by
 * a higher-scored match.
 *
 * Uses a reverse-scan over the sorted merged array
 * so each entity only compares against nearby
 * predecessors — O(n * w) average where w is the max
 * entities per POSITION_THRESHOLD window, O(n²) worst
 * case when replacements dominate (splice is O(n)).
 */
export const mergeChunkEntities = (
  chunkOffsets: number[],
  chunkResults: Entity[][],
): Entity[] => {
  const allEntities: Entity[] = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const offset = chunkOffsets[i] ?? 0;
    const entities = chunkResults[i];
    if (!entities) {
      continue;
    }
    for (const entity of entities) {
      allEntities.push({
        ...entity,
        start: entity.start + offset,
        end: entity.end + offset,
      });
    }
  }

  const sorted = allEntities.toSorted((a, b) => a.start - b.start);
  const merged: Entity[] = [];

  for (const entity of sorted) {
    let bestDupIndex = -1;
    let bestDupScore = -1;

    // Reverse-scan the full proximity window. Collect
    // the highest-scored same-label match so we dedup
    // against the strongest existing entity, not just
    // the nearest one.
    for (let j = merged.length - 1; j >= 0; j--) {
      const existing = merged[j];
      if (existing === undefined) {
        continue;
      }
      // merged is kept sorted by start (splice+push
      // maintains this); elements further back have
      // even smaller starts, so we can break early.
      if (entity.start - existing.start >= POSITION_THRESHOLD) {
        break;
      }
      if (
        existing.label === entity.label &&
        Math.abs(existing.end - entity.end) < POSITION_THRESHOLD &&
        existing.score > bestDupScore
      ) {
        bestDupIndex = j;
        bestDupScore = existing.score;
      }
    }

    if (bestDupIndex !== -1) {
      const existing = merged[bestDupIndex];
      if (existing !== undefined && entity.score > existing.score) {
        // Replace with winner. Splice out the old entry
        // and re-insert at the end to maintain sorted
        // order (entity.start >= all prior starts).
        merged.splice(bestDupIndex, 1);
        merged.push({ ...entity });
      }
      // Entity loses to the best match and is dropped.
      // Other lower-scored near-dups of this entity are
      // not revisited (see docstring dedup invariant).
    } else {
      merged.push({ ...entity });
    }
  }

  return merged;
};
