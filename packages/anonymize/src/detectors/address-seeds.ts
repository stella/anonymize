/**
 * Address detection via seed expansion.
 *
 * 1. Find "address seeds" — high-confidence address
 *    components (postal codes, cities, street types)
 * 2. Cluster nearby seeds (within ~150 chars)
 * 3. Expand each cluster to the full address span
 * 4. Score by seed diversity (more types = higher)
 *
 * Language-agnostic: street type words and boundary
 * words are loaded from data dictionaries, not
 * hardcoded per language.
 */

import type { Match } from "@stll/text-search";

import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

// ── Seed types ──────────────────────────────────────

type SeedType =
  | "street-word"
  | "house-number"
  | "postal-code"
  | "city"
  | "address-trigger";

type Seed = {
  type: SeedType;
  start: number;
  end: number;
  text: string;
};

// ── Dictionary loading ──────────────────────────────

type DictionaryConfig = Record<string, string[] | string>;

let cachedBoundaryRe: RegExp | null = null;

const loadBoundaryWords = async (): Promise<DictionaryConfig> => {
  try {
    const mod = await import("../data/address-boundaries.json");
    return mod.default as DictionaryConfig;
  } catch {
    return {};
  }
};

/**
 * Build regex for boundary words. Matches any
 * boundary word preceded by a word boundary.
 */
const getBoundaryRe = async (): Promise<RegExp> => {
  if (cachedBoundaryRe) {
    return cachedBoundaryRe;
  }
  const config = await loadBoundaryWords();
  const words: string[] = [];
  for (const entries of Object.values(config)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const word of entries) {
      // Escape regex special chars
      words.push(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  // Sort longest first so longer phrases match first
  words.sort((a, b) => b.length - a.length);
  cachedBoundaryRe =
    words.length > 0 ? new RegExp(`\\b(?:${words.join("|")})\\b`, "i") : /(?!)/; // never matches
  return cachedBoundaryRe;
};

// ── Pattern builder for unified search ──────────────

/**
 * Build street type patterns for the unified search.
 * Returns string[] for the unified TextSearch
 * builder. Empty if data package is not installed.
 */
export const buildStreetTypePatterns = async (): Promise<string[]> => {
  let config: DictionaryConfig = {};
  try {
    const mod = await import("../data/address-street-types.json");
    config = mod.default as DictionaryConfig;
  } catch {
    return [];
  }

  // Plain strings — the unified builder sets
  // caseInsensitive + wholeWords globally.
  const words: string[] = [];
  for (const values of Object.values(config)) {
    if (!Array.isArray(values)) {
      continue;
    }
    for (const word of values) {
      words.push(word);
    }
  }
  return words;
};

// ── Seed collection ─────────────────────────────────

const collectSeeds = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  existingEntities: Entity[],
): Seed[] => {
  const seeds: Seed[] = [];

  // 1. Street type words from unified search matches
  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }
    seeds.push({
      type: "street-word",
      start: match.start,
      end: match.end,
      text: match.text,
    });
  }

  // 2. Cities and postal codes from existing entities
  for (const e of existingEntities) {
    if (e.label !== "address") {
      continue;
    }
    if (e.source === "deny-list") {
      seeds.push({
        type: "city",
        start: e.start,
        end: e.end,
        text: e.text,
      });
    } else if (e.source === "trigger" && /^\d/.test(e.text)) {
      seeds.push({
        type: "postal-code",
        start: e.start,
        end: e.end,
        text: e.text,
      });
    } else if (e.source === "trigger") {
      seeds.push({
        type: "address-trigger",
        start: e.start,
        end: e.end,
        text: e.text,
      });
    }
  }

  // 3. Standalone postal codes (multiple formats):
  //   Czech/Slovak: NNN NN (e.g., 140 00)
  //   Polish: NN-NNN (e.g., 00-950)
  const postalRe = /\b(?:\d{3}\s\d{2}|\d{2}-\d{3})\b/g;
  let postalMatch;
  while ((postalMatch = postalRe.exec(fullText)) !== null) {
    const start = postalMatch.index;
    const end = start + postalMatch[0].length;
    const alreadyCovered = seeds.some((s) => s.start <= start && s.end >= end);
    if (!alreadyCovered) {
      seeds.push({
        type: "postal-code",
        start,
        end,
        text: postalMatch[0],
      });
    }
  }

  // 4. Street name + house number pattern:
  // [CapitalizedWord] [number](/[number])?,
  // e.g., "Olbrachtova 1929/62," or "Kamínky 5,"
  const streetNumRe =
    /\b(\p{Lu}\p{Ll}{2,})\s+(\d{1,5}(?:\/\d{1,5})?)\s*[,\n]/gu;
  let streetMatch;
  while ((streetMatch = streetNumRe.exec(fullText)) !== null) {
    const matchedStreet = streetMatch[1];
    const matchedNum = streetMatch[2];
    if (!matchedStreet || !matchedNum) {
      continue;
    }
    const start = streetMatch.index;
    const end = start + matchedStreet.length + 1 + matchedNum.length;
    seeds.push({
      type: "street-word",
      start,
      end,
      text: fullText.slice(start, end),
    });
  }

  return seeds.sort((a, b) => a.start - b.start);
};

// ── Cluster nearby seeds ────────────────────────────

type SeedCluster = {
  seeds: Seed[];
  start: number;
  end: number;
};

const clusterSeeds = (seeds: Seed[], maxGap: number): SeedCluster[] => {
  const first = seeds[0];
  if (!first) {
    return [];
  }

  const clusters: SeedCluster[] = [];
  let current: SeedCluster = {
    seeds: [first],
    start: first.start,
    end: first.end,
  };

  for (let i = 1; i < seeds.length; i++) {
    const seed = seeds.at(i);
    if (!seed) {
      continue;
    }
    if (seed.start - current.end <= maxGap) {
      current.seeds.push(seed);
      current.end = Math.max(current.end, seed.end);
    } else {
      clusters.push(current);
      current = {
        seeds: [seed],
        start: seed.start,
        end: seed.end,
      };
    }
  }
  clusters.push(current);

  return clusters;
};

// ── Score a cluster ─────────────────────────────────

const scoreCluster = (cluster: SeedCluster): number => {
  const types = new Set(cluster.seeds.map((s) => s.type));

  // Need at least 2 different seed types for an
  // address (e.g., city + postal code, or street
  // word + house number)
  if (types.size < 2) {
    return 0;
  }

  let score = 0.5;

  if (types.has("postal-code")) score += 0.15;
  if (types.has("city")) score += 0.15;
  if (types.has("street-word")) score += 0.15;
  if (types.has("address-trigger")) score += 0.1;

  return Math.min(score, 0.95);
};

// ── Expand cluster to full address span ─────────────

const NON_ADDRESS_LABELS = new Set([
  "registration number",
  "tax identification number",
  "person",
  "bank account number",
  "email address",
  "phone number",
  "organization",
  "iban",
]);

const expandCluster = async (
  fullText: string,
  cluster: SeedCluster,
  existingEntities: Entity[],
): Promise<{ start: number; end: number }> => {
  const { start, end } = cluster;

  // Find the nearest non-address entity to the LEFT
  let leftBound = 0;
  for (const e of existingEntities) {
    if (
      NON_ADDRESS_LABELS.has(e.label) &&
      e.end <= start &&
      e.end > leftBound
    ) {
      leftBound = e.end;
    }
  }

  // Expand left: include preceding capitalized words
  // and numbers (street name before the street type)
  let leftPos = start;
  while (leftPos > leftBound) {
    let p = leftPos - 1;
    while (p >= 0 && (fullText[p] === " " || fullText[p] === ",")) {
      p--;
    }
    if (p < 0) break;

    let wordEnd = p + 1;
    while (p >= 0 && /\S/.test(fullText[p] ?? "")) {
      p--;
    }
    const word = fullText.slice(p + 1, wordEnd);

    if (word.length < 2 || (!/^\p{Lu}/u.test(word) && !/^\d/.test(word))) {
      break;
    }

    if (fullText.slice(p + 1, leftPos).includes("\n")) {
      break;
    }

    leftPos = p + 1;
  }

  // Expand right: include following text until we
  // hit a boundary word, non-address entity,
  // double newline, or 200 char cap.
  let rightPos = end;
  const remaining = fullText.slice(rightPos);
  let nearestBoundary = Math.min(remaining.length, 200);

  // Stop at dictionary-defined boundary words
  const boundaryRe = await getBoundaryRe();
  const boundaryMatch = boundaryRe.exec(remaining);
  if (boundaryMatch && boundaryMatch.index < nearestBoundary) {
    nearestBoundary = boundaryMatch.index;
  }

  // Stop at non-address entities
  for (const e of existingEntities) {
    if (!NON_ADDRESS_LABELS.has(e.label)) {
      continue;
    }
    const offset = e.start - rightPos;
    if (offset > 0 && offset < nearestBoundary) {
      nearestBoundary = offset;
    }
  }

  // Stop at double newline (paragraph break)
  const doubleNewline = remaining.indexOf("\n\n");
  if (doubleNewline !== -1 && doubleNewline < nearestBoundary) {
    nearestBoundary = doubleNewline;
  }

  const expanded = remaining.slice(0, nearestBoundary).trimEnd();
  rightPos = end + expanded.length;

  // Trim trailing punctuation
  while (rightPos > end && /[,;:\s]/.test(fullText[rightPos - 1] ?? "")) {
    rightPos--;
  }

  return {
    start: Math.min(leftPos, start),
    end: Math.max(rightPos, end),
  };
};

// ── Public API ──────────────────────────────────────

/**
 * Process address seeds from the unified search.
 * Receives all matches; filters to the street types
 * slice via sliceStart/sliceEnd. Uses fullText and
 * existingEntities for seed collection, clustering,
 * expansion, and scoring.
 *
 * Runs as a post-processor after all other detectors,
 * using their output as seed sources.
 */
export const processAddressSeeds = async (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  existingEntities: Entity[],
): Promise<Entity[]> => {
  const seeds = collectSeeds(
    allMatches,
    sliceStart,
    sliceEnd,
    fullText,
    existingEntities,
  );
  const clusters = clusterSeeds(seeds, 150);

  const results: Entity[] = [];

  for (const cluster of clusters) {
    const score = scoreCluster(cluster);
    if (score < 0.6) {
      continue;
    }

    const { start, end } = await expandCluster(
      fullText,
      cluster,
      existingEntities,
    );
    const text = fullText.slice(start, end).trim();

    // Skip very short or very long spans
    if (text.length < 5 || text.length > 300) {
      continue;
    }

    // Skip if it contains a newline (likely crossed
    // a structural boundary)
    if (text.includes("\n")) {
      continue;
    }

    results.push({
      start,
      end: start + text.length,
      label: "address",
      text,
      score,
      source: DETECTION_SOURCES.REGEX,
    });
  }

  return results;
};
