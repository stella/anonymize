import type { Entity } from "../types";

const MAX_CHUNK_CHARS = 1500;
const OVERLAP_CHARS = 50;
const MIN_CHUNK_LENGTH = 10;

/**
 * Split text into overlapping chunks for GLiNER's
 * ~512 token context window. Character-based splitting
 * (rough approximation of token limits).
 *
 * Tries to break at sentence boundaries when possible.
 */
export const chunkText = (text: string): string[] => {
  const chunks: string[] = [];
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
      chunks.push(chunk);
    }
    offset = Math.max(offset + 1, end - OVERLAP_CHARS);
  }

  return chunks;
};

/**
 * Compute the byte offset of each chunk within the
 * original document text.
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
 * Uses a reverse-scan over the sorted merged array
 * so each entity only compares against nearby
 * predecessors — O(n) amortised instead of O(n²).
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

  const sorted = allEntities.toSorted(
    (a, b) => a.start - b.start,
  );
  const merged: Entity[] = [];

  for (const entity of sorted) {
    let dupIndex = -1;

    // Reverse-scan: check all recent entries whose
    // start is within the proximity window. Skip
    // non-matching labels instead of breaking, since
    // different-label entities can interleave at the
    // same position.
    for (let j = merged.length - 1; j >= 0; j--) {
      const existing = merged[j];
      if (existing === undefined) {
        continue;
      }
      if (
        entity.start - existing.start
          >= POSITION_THRESHOLD
      ) {
        break;
      }
      if (
        existing.label === entity.label &&
        Math.abs(existing.end - entity.end)
          < POSITION_THRESHOLD
      ) {
        dupIndex = j;
        break;
      }
    }

    if (dupIndex !== -1) {
      const existing = merged[dupIndex];
      if (
        existing !== undefined &&
        entity.score > existing.score
      ) {
        // Replace with winner. Splice out the old entry
        // and re-insert at the end to maintain sorted
        // order (entity.start >= all prior starts).
        merged.splice(dupIndex, 1);
        merged.push({ ...entity });
      }
    } else {
      merged.push({ ...entity });
    }
  }

  return merged;
};
