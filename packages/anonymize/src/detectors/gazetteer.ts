import type { Match, PatternEntry } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type { Entity, GazetteerEntry } from "../types";
import type { GazetteerData } from "../build-unified-search";

const MAX_EDIT_DISTANCE = 2;
const MIN_FUZZY_LENGTH = 4;
const MAX_PREFIX_OVERSHOOT = 6;

/**
 * Collect all searchable strings (canonical + variants)
 * from gazetteer entries, mapped to their labels and
 * entry IDs.
 */
export const buildSearchTerms = (
  entries: GazetteerEntry[],
): Map<string, { label: string; entryId: string }> => {
  const terms = new Map<
    string,
    { label: string; entryId: string }
  >();
  for (const entry of entries) {
    const meta = {
      label: entry.label,
      entryId: entry.id,
    };
    terms.set(entry.canonical, meta);
    for (const variant of entry.variants) {
      terms.set(variant, meta);
    }
  }
  return terms;
};

/**
 * Build TextSearch-compatible patterns from gazetteer
 * entries. Returns:
 * - Exact literal patterns for all terms
 * - Fuzzy patterns (distance: 2) for terms >= 4 chars
 * - Parallel metadata arrays for post-processing
 *
 * Patterns are ordered: all exact first, then all
 * fuzzy. The isFuzzy array marks which are which.
 */
export const buildGazetteerPatterns = (
  entries: GazetteerEntry[],
): {
  patterns: PatternEntry[];
  data: GazetteerData;
} => {
  const terms = buildSearchTerms(entries);

  const patterns: PatternEntry[] = [];
  const labels: string[] = [];
  const entryIds: string[] = [];
  const isFuzzy: boolean[] = [];

  // Pass 1: exact literals (all terms)
  for (const [term, meta] of terms) {
    patterns.push(term);
    labels.push(meta.label);
    entryIds.push(meta.entryId);
    isFuzzy.push(false);
  }

  // Pass 2: fuzzy patterns (terms >= 4 chars).
  // These are separate patterns with distance: 2,
  // routed to @stll/fuzzy-search by TextSearch.
  for (const [term, meta] of terms) {
    if (term.length < MIN_FUZZY_LENGTH) {
      continue;
    }
    patterns.push({
      pattern: term,
      distance: MAX_EDIT_DISTANCE,
    });
    labels.push(meta.label);
    entryIds.push(meta.entryId);
    isFuzzy.push(true);
  }

  return {
    patterns,
    data: { labels, entryIds, isFuzzy },
  };
};

/**
 * Process gazetteer matches from the unified literal
 * search. Receives all matches; filters to the
 * gazetteer slice via sliceStart/sliceEnd.
 *
 * Exact matches get score 0.9; fuzzy matches get
 * 0.85. Fuzzy matches that overlap an exact match
 * are dropped.
 *
 * For exact matches, attempts prefix extension for
 * legal suffixes ("a.s.", "GmbH", "s.r.o." after
 * the matched term).
 */
export const processGazetteerMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  data: GazetteerData,
): Entity[] => {
  const results: Entity[] = [];
  // Track exact-match spans for overlap filtering
  const exactSpans: Array<{
    start: number;
    end: number;
  }> = [];

  // Pass 1: exact matches (isFuzzy === false)
  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }
    const localIdx = idx - sliceStart;
    if (data.isFuzzy[localIdx]) {
      continue;
    }

    const label = data.labels[localIdx];
    if (!label) {
      continue;
    }

    const matchText = fullText.slice(
      match.start,
      match.end,
    );

    // Try prefix extension for legal entity suffixes
    const extended = tryPrefixExtension(
      fullText,
      match.start,
      match.end,
    );
    if (extended) {
      exactSpans.push({
        start: match.start,
        end: extended.end,
      });
      results.push({
        start: match.start,
        end: extended.end,
        label,
        text: extended.text,
        score: 0.9,
        source: DETECTION_SOURCES.GAZETTEER,
      });
      continue;
    }

    exactSpans.push({
      start: match.start,
      end: match.end,
    });
    results.push({
      start: match.start,
      end: match.end,
      label,
      text: matchText,
      score: 0.9,
      source: DETECTION_SOURCES.GAZETTEER,
    });
  }

  // Pass 2: fuzzy matches (isFuzzy === true),
  // skipping those that overlap exact spans
  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }
    const localIdx = idx - sliceStart;
    if (!data.isFuzzy[localIdx]) {
      continue;
    }

    // Skip distance-0 fuzzy hits (already caught
    // as exact matches above)
    if (match.distance === 0) {
      continue;
    }

    const label = data.labels[localIdx];
    if (!label) {
      continue;
    }

    // Skip if overlapping any exact span
    const overlapsExact = exactSpans.some(
      (e) =>
        match.start < e.end && match.end > e.start,
    );
    if (overlapsExact) {
      continue;
    }

    const matchText = fullText.slice(
      match.start,
      match.end,
    );
    results.push({
      start: match.start,
      end: match.end,
      label,
      text: matchText,
      score: 0.85,
      source: DETECTION_SOURCES.GAZETTEER,
    });
  }

  return results;
};

/**
 * Try to extend an exact match to include a legal
 * entity suffix. Returns null if no suffix found.
 */
const tryPrefixExtension = (
  fullText: string,
  start: number,
  end: number,
): { end: number; text: string } | null => {
  const maxEnd = end + MAX_PREFIX_OVERSHOOT;
  if (maxEnd > fullText.length) {
    return null;
  }

  const after = fullText.slice(end, maxEnd);
  if (!after.startsWith(" ")) {
    return null;
  }
  const nextSpace = after.indexOf(" ", 1);
  const suffixEnd =
    nextSpace !== -1 ? nextSpace : after.length;
  if (suffixEnd <= 1) {
    return null;
  }

  const newEnd = end + suffixEnd;
  return {
    end: newEnd,
    text: fullText.slice(start, newEnd),
  };
};

// Deprecated exports (kept for API compat)

/**
 * @deprecated Use the unified search pipeline
 * instead. This is a no-op that returns [].
 */
export const scanExact = (
  _fullText: string,
  _entries: GazetteerEntry[],
): Entity[] => [];

/**
 * @deprecated Use the unified search pipeline
 * instead. This is a no-op that returns [].
 */
export const scanFuzzy = (
  _fullText: string,
  _entries: GazetteerEntry[],
  _exactSpans: Entity[],
): Entity[] => [];
