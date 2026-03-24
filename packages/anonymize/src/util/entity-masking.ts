import type { Entity } from "../types";

const MASK_TOKEN = "[MASKED]";
const MASK_LEN = MASK_TOKEN.length;

type OffsetSegment = {
  /** Start of this mask token in masked text */
  maskedStart: number;
  /** End of this mask token in masked text */
  maskedEnd: number;
  /** Cumulative shift: original - masked */
  shift: number;
  /** Original start of the masked span */
  origStart: number;
  /** Original end of the masked span */
  origEnd: number;
};

export type MaskResult = {
  maskedText: string;
  /**
   * Maps masked-text offsets back to original offsets.
   * Returns null if the span overlaps a masked region.
   */
  offsetMap: (
    maskedStart: number,
    maskedEnd: number,
  ) => { start: number; end: number } | null;
};

/**
 * Replace detected entity spans with placeholder tokens.
 * Each entity span is replaced with "[MASKED]" (fixed
 * length). Returns the masked text and an offset mapping
 * function.
 */
export const maskDetectedSpans = (
  fullText: string,
  entities: Entity[],
): MaskResult => {
  if (entities.length === 0) {
    return {
      maskedText: fullText,
      offsetMap: (s, e) => ({ start: s, end: e }),
    };
  }

  // Sort by start, then longest span first
  const sorted = entities.toSorted(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  // Merge overlapping spans so we don't double-mask
  const spans: { start: number; end: number }[] = [];
  let cur = {
    start: sorted[0].start,
    end: sorted[0].end,
  };
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start < cur.end) {
      cur.end = Math.max(cur.end, s.end);
    } else {
      spans.push(cur);
      cur = { start: s.start, end: s.end };
    }
  }
  spans.push(cur);

  // Build masked text and offset segments
  const segments: OffsetSegment[] = [];
  const parts: string[] = [];
  let prev = 0;
  let cumulativeShift = 0;

  for (const span of spans) {
    parts.push(fullText.slice(prev, span.start));
    parts.push(MASK_TOKEN);

    const origLen = span.end - span.start;
    const delta = origLen - MASK_LEN;
    cumulativeShift += delta;

    // Position of mask token in masked text
    const maskedStart =
      span.start - (cumulativeShift - delta);
    const maskedEnd = maskedStart + MASK_LEN;

    segments.push({
      maskedStart,
      maskedEnd,
      shift: cumulativeShift,
      origStart: span.start,
      origEnd: span.end,
    });

    prev = span.end;
  }
  parts.push(fullText.slice(prev));

  const maskedText = parts.join("");

  const offsetMap = (
    maskedStart: number,
    maskedEnd: number,
  ): { start: number; end: number } | null => {
    // Check if span overlaps any masked region
    for (const seg of segments) {
      if (
        maskedStart < seg.maskedEnd &&
        maskedEnd > seg.maskedStart
      ) {
        return null;
      }
    }

    // Find cumulative shift for start position
    let startShift = 0;
    for (const seg of segments) {
      if (maskedStart >= seg.maskedEnd) {
        startShift = seg.shift;
      } else {
        break;
      }
    }

    let endShift = 0;
    for (const seg of segments) {
      if (maskedEnd >= seg.maskedEnd) {
        endShift = seg.shift;
      } else {
        break;
      }
    }

    return {
      start: maskedStart + startShift,
      end: maskedEnd + endShift,
    };
  };

  return { maskedText, offsetMap };
};

/**
 * Map NER entities from masked-text offsets back to
 * original-text offsets. Discards any NER entity whose
 * mapped span overlaps a masked (rule-detected) region.
 */
export const unmaskNerEntities = (
  nerEntities: Entity[],
  maskResult: MaskResult,
  ruleEntities: Entity[],
  fullText: string,
): Entity[] => {
  const result: Entity[] = [];

  for (const ner of nerEntities) {
    const mapped = maskResult.offsetMap(
      ner.start,
      ner.end,
    );
    if (mapped === null) continue;

    // Double-check overlap with rule entities
    let overlaps = false;
    for (const rule of ruleEntities) {
      if (
        mapped.start < rule.end &&
        mapped.end > rule.start
      ) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    result.push({
      ...ner,
      start: mapped.start,
      end: mapped.end,
      text: fullText.slice(mapped.start, mapped.end),
    });
  }

  return result;
};
