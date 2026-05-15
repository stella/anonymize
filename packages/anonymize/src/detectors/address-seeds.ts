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
import {
  DASH,
  DASH_INNER,
  OPENING_BRACKETS_INNER,
  QUOTE_DOUBLE_INNER,
  QUOTE_SINGLE_INNER,
} from "../util/char-groups";

/**
 * Trailing chars that should never end an address span. Combines
 * structural separators, opening brackets, and typographic quote
 * variants so a span like `… GA 30326, USA (the "Premises")`
 * does not pull the parenthetical opener into the address.
 * The prime (`′`) catches measurement tails (`5′`) that the
 * cluster occasionally absorbs.
 */
const ADDRESS_TRAILING_TRIM_RE = new RegExp(
  `[,;:\\s${OPENING_BRACKETS_INNER}${QUOTE_DOUBLE_INNER}${QUOTE_SINGLE_INNER}′]`,
  "u",
);
const POSTAL_ADJACENT = `\\p{L}\\p{N}_${DASH_INNER}`;
const POSTAL_CODE_RE = new RegExp(
  `(?<![${POSTAL_ADJACENT}])` +
    `(?:\\d{3}\\s\\d{2}|\\d{2}${DASH}\\d{3}|\\d{5}${DASH}\\d{3}|\\d{5}${DASH}\\d{4})` +
    `(?![${POSTAL_ADJACENT}])`,
  "gu",
);
const BR_CEP_SHAPE_RE = new RegExp(`^\\d{5}${DASH}\\d{3}$`, "u");
const US_ZIP_PLUS_FOUR_SHAPE_RE = new RegExp(`^\\d{5}${DASH}\\d{4}$`, "u");
const US_STATE_ABBREV =
  "A[KLRZ]|C[AOT]|D[CE]|F[LM]|G[AU]|HI|I[ADLN]|K[SY]|LA|" +
  "M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|" +
  "UT|V[AIT]|W[AIVY]";
const US_STATE_ABBREV_BEFORE_ZIP_RE = new RegExp(
  `(?:^|[^A-Za-z0-9])(${US_STATE_ABBREV})\\s*,?\\s*$`,
  "u",
);
const US_ZIP_CONTEXT_WINDOW = 120;
const US_CITY_ZIP_GAP_RE = /^[\s,]+$/u;
const HOUSE_NUMBER_BEFORE_STREET_RE =
  /\b\d{1,6}(?:[-/]\d{1,6})?\s+(?:\p{Lu}\p{L}+[^\S\n\t]+){0,4}$/u;
const HOUSE_NUMBER_AFTER_STREET_RE = /^[^\S\n\t]+\d{1,6}(?:[-/]\d{1,6})?\b/u;

// ── Seed types ──────────────────────────────────────

type SeedType =
  | "street-word"
  | "house-number"
  | "postal-code"
  | "city"
  | "state"
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

// ── pt-BR CEP context gating ────────────────────────
//
// The bare `\d{5}-\d{3}` CEP shape collides with non-
// address identifiers ("Order 12345-678"), so the seed
// is only accepted when a pt-BR cue word appears within
// the cluster window around it. The cue regex is built
// once from the pt-BR entries of `address-street-types`
// and `address-boundaries` (no hardcoded language strings
// in TS). The window matches the seed-cluster gap so a
// CEP that would otherwise cluster with a non-BR `city`
// seed is filtered out before clustering.

const BR_CEP_CONTEXT_WINDOW = 200;

let cachedBrCepContextRe: RegExp | null = null;
let cachedBrCepContextPromise: Promise<RegExp | null> | null = null;

const loadBrCueWords = async (): Promise<readonly string[]> => {
  const sources = await Promise.all([
    (async () => {
      try {
        const mod = await import("../data/address-street-types.json");
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON shape
        return (mod.default as DictionaryConfig)["pt-br"];
      } catch {
        return undefined;
      }
    })(),
    (async () => {
      try {
        const mod = await import("../data/address-boundaries.json");
        // eslint-disable-next-line no-unsafe-type-assertion -- JSON shape
        return (mod.default as DictionaryConfig)["pt-br"];
      } catch {
        return undefined;
      }
    })(),
  ]);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of sources) {
    if (!Array.isArray(entry)) continue;
    for (const word of entry) {
      if (typeof word !== "string" || word.length === 0) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out;
};

const getBrCepContextRe = async (): Promise<RegExp | null> => {
  if (cachedBrCepContextRe !== null) {
    return cachedBrCepContextRe;
  }
  if (cachedBrCepContextPromise) {
    return cachedBrCepContextPromise;
  }
  cachedBrCepContextPromise = (async () => {
    const words = await loadBrCueWords();
    if (words.length === 0) return null;
    const escaped = words
      .toSorted((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`,
      "iu",
    );
    cachedBrCepContextRe = re;
    return re;
  })();
  return cachedBrCepContextPromise;
};

const hasBrCueNearby = (
  fullText: string,
  start: number,
  end: number,
  re: RegExp,
): boolean => {
  const windowStart = Math.max(0, start - BR_CEP_CONTEXT_WINDOW);
  const windowEnd = Math.min(fullText.length, end + BR_CEP_CONTEXT_WINDOW);
  const window = fullText.slice(windowStart, windowEnd);
  // Build a fresh non-global RegExp per call — sharing
  // would carry lastIndex across calls.
  const probe = new RegExp(re.source, re.flags.replace("g", ""));
  return probe.test(window);
};

type UsZipPlusFourContext = {
  stateSeed: Seed | null;
  hasContext: boolean;
};

const getUsStateSeedBeforeZip = (
  fullText: string,
  start: number,
): Seed | null => {
  const stateWindowStart = Math.max(0, start - 24);
  const stateWindow = fullText.slice(stateWindowStart, start);
  const match = US_STATE_ABBREV_BEFORE_ZIP_RE.exec(stateWindow);
  const state = match?.[1];
  if (!match || !state) {
    return null;
  }

  const stateOffset = match[0].indexOf(state);
  const stateStart = stateWindowStart + match.index + stateOffset;
  return {
    type: "state",
    start: stateStart,
    end: stateStart + state.length,
    text: state,
  };
};

const hasHouseNumberNearStreetWord = (
  fullText: string,
  seed: Seed,
): boolean => {
  if (/\d/.test(seed.text)) {
    return true;
  }

  const before = fullText.slice(Math.max(0, seed.start - 50), seed.start);
  if (HOUSE_NUMBER_BEFORE_STREET_RE.test(before)) {
    return true;
  }

  const after = fullText.slice(
    seed.end,
    Math.min(fullText.length, seed.end + 24),
  );
  return HOUSE_NUMBER_AFTER_STREET_RE.test(after);
};

const getUsZipPlusFourContext = (
  fullText: string,
  start: number,
  seeds: readonly Seed[],
): UsZipPlusFourContext => {
  const stateSeed = getUsStateSeedBeforeZip(fullText, start);
  if (stateSeed !== null) {
    return { stateSeed, hasContext: true };
  }

  const hasContext = seeds.some((seed) => {
    if (Math.abs(seed.start - start) > US_ZIP_CONTEXT_WINDOW) {
      return false;
    }
    if (seed.type === "address-trigger") {
      return true;
    }
    if (seed.type === "city" && seed.end <= start) {
      const gap = fullText.slice(seed.end, start);
      return US_CITY_ZIP_GAP_RE.test(gap);
    }
    if (seed.type === "street-word") {
      return hasHouseNumberNearStreetWord(fullText, seed);
    }
    return false;
  });
  return { stateSeed: null, hasContext };
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
  // Word-boundary lookarounds via unicode letter/number
  // classes — `\b` doesn't fire after non-word chars, so a
  // phrase ending in `.` (e.g. `sp. zn.`, `r.č.`, Italian
  // `C.F.`, Spanish `con C.I.F.`) would never match with
  // `\b...\b`. The lookarounds anchor on the absence of a
  // letter/digit on either side, which works regardless of
  // the phrase's last character.
  cachedBoundaryRe =
    words.length > 0
      ? new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`,
          "iu",
        )
      : /(?!)/;
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
  brCepContextRe: RegExp | null,
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
    if (e.sourceDetail === "custom-deny-list") {
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
  //   Brazilian CEP: NNNNN-NNN (e.g., 01001-000)
  //   US ZIP+4: NNNNN-NNNN (e.g., 94304-1050)
  // The CEP shape collides with bare order/ticket numbers
  // ("Order 12345-678"), and the cluster's other seed
  // could be a non-BR deny-list city. To prevent that, the
  // CEP-shaped seed is only kept when a pt-BR cue word
  // (rua/avenida/CNPJ/CPF/RG/…) appears within the cluster
  // window around it. The Czech/Slovak and Polish shapes
  // are distinctive enough not to need a similar gate. US
  // ZIP+4 seeds are only kept with nearby address evidence
  // because business/order IDs often share the same shape.
  const postalRe = POSTAL_CODE_RE;
  postalRe.lastIndex = 0;
  let postalMatch;
  while ((postalMatch = postalRe.exec(fullText)) !== null) {
    const start = postalMatch.index;
    const end = start + postalMatch[0].length;
    const alreadyCovered = seeds.some((s) => s.start <= start && s.end >= end);
    if (alreadyCovered) {
      continue;
    }
    const isCepShape = BR_CEP_SHAPE_RE.test(postalMatch[0]);
    if (
      isCepShape &&
      (brCepContextRe === null ||
        !hasBrCueNearby(fullText, start, end, brCepContextRe))
    ) {
      continue;
    }
    const isUsZipPlusFourShape = US_ZIP_PLUS_FOUR_SHAPE_RE.test(postalMatch[0]);
    if (isUsZipPlusFourShape) {
      const usContext = getUsZipPlusFourContext(fullText, start, seeds);
      if (!usContext.hasContext) {
        continue;
      }
      const stateSeed = usContext.stateSeed;
      if (stateSeed !== null) {
        const hasStateSeed = seeds.some(
          (seed) =>
            seed.start === stateSeed.start && seed.end === stateSeed.end,
        );
        if (!hasStateSeed) {
          seeds.push(stateSeed);
        }
      }
    }
    seeds.push({
      type: "postal-code",
      start,
      end,
      text: postalMatch[0],
    });
  }

  // 3b. Italian CAP: 5 consecutive digits followed by a
  // capitalised word ("41012 Carpi", "41012 MODENA"). The
  // capitalised word requirement keeps random 5-digit IDs
  // (years, order numbers) out, and the explicit
  // address-evidence-within-80-chars gate keeps a stray
  // "12345 Paris" reference from accidentally clustering
  // into an address in non-Italian text. A bare "via"
  // street-word does not count on its own — it is also a
  // common English preposition matched case-insensitively
  // ("sent via form 12345 Paris"), so require either an
  // address trigger / city / postal seed nearby, or a
  // street-word other than a standalone lowercase "via".
  const itCapRe = /\b\d{5}(?=\s+\p{Lu}\p{L}+)/gu;
  let itCapMatch;
  while ((itCapMatch = itCapRe.exec(fullText)) !== null) {
    const start = itCapMatch.index;
    const end = start + itCapMatch[0].length;
    const alreadyCovered = seeds.some((s) => s.start <= start && s.end >= end);
    if (alreadyCovered) continue;
    const hasNearbyAddressEvidence = seeds.some((s) => {
      if (Math.abs(s.start - start) > 80) return false;
      if (s.type === "address-trigger") return true;
      if (s.type === "city") return true;
      if (s.type === "postal-code") return true;
      if (s.type === "street-word") {
        // Reject the bare English preposition "via" as the
        // sole signal; any longer or non-"via" street word
        // (Piazza, Viale, Corso, Via Roma) still qualifies.
        return s.text.toLowerCase() !== "via";
      }
      return false;
    });
    if (!hasNearbyAddressEvidence) continue;
    seeds.push({
      type: "postal-code",
      start,
      end,
      text: itCapMatch[0],
    });
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
  if (types.has("state")) score += 0.15;
  if (types.has("street-word")) score += 0.15;
  if (types.has("address-trigger")) score += 0.1;

  return Math.min(score, 0.95);
};

// ── Expand cluster to full address span ─────────────

const NON_ADDRESS_LABELS = new Set([
  "registration number",
  "tax identification number",
  "national identification number",
  "social security number",
  "birth number",
  "identity card number",
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

  while (
    rightPos > end &&
    ADDRESS_TRAILING_TRIM_RE.test(fullText[rightPos - 1] ?? "")
  ) {
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
  const brCepContextRe = await getBrCepContextRe();
  const seeds = collectSeeds(
    allMatches,
    sliceStart,
    sliceEnd,
    fullText,
    existingEntities,
    brCepContextRe,
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
