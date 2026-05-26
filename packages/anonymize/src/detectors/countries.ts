import type { Match, PatternEntry } from "@stll/text-search";

import { DETECTION_SOURCES } from "../constants";
import type { Entity } from "../types";
import { normalizeForSearch } from "../util/normalize";

import countriesData from "../data/countries.json" with { type: "json" };

const ENTITY_LABEL = "country";
const EXACT_SCORE = 0.95;

/**
 * Whether to surface bare ISO 3166-1 alpha-2 codes
 * ("US", "GB", "IT") as country matches. Off by default
 * because two-letter sequences collide constantly with
 * English/legal prose ("IT department", "OR", pronouns).
 */
const INCLUDE_ALPHA2 = false;

/**
 * CLDR canonical names that collide with common
 * English/global words. Filtered before registration so
 * they never become whole-word case-insensitive country
 * patterns. Examples: "Island" is Icelandic for Iceland
 * (also Da/No/Sv/Fi); "Man" is Norwegian for Isle of Man;
 * "Indie" is the Czech and Polish form of India and
 * collides with the English adjective ("indie developer").
 * All would flag every English occurrence as a country.
 */
const NAME_BLOCKLIST: ReadonlySet<string> = new Set(
  ["man", "island", "indie"].map((s) => s.toLowerCase()),
);

/**
 * Whether to surface ISO 3166-1 alpha-3 codes ("USA",
 * "GBR", "JPN") as country matches. Off by default
 * because alpha-3 codes collide case-insensitively with
 * common English/Spanish words: AND (Andorra), ARE (UAE),
 * CAN (Canada), PER (Peru), VAT (Vatican), COG, DOM,
 * FIN, GIN, LIE, MAR, NAM, PAN, TON, etc. A
 * case-sensitive matcher would solve this but the unified
 * literal search runs case-insensitive. Common alpha-3
 * forms ("USA") are covered by the curated aliases list
 * instead.
 */
const INCLUDE_ALPHA3 = false;

/**
 * Pre-built country patterns + parallel label/source
 * metadata. Constructed once and reused across pipeline
 * runs.
 */
export type CountryData = {
  /** Maps local pattern index to entity label. Always "country". */
  labels: string[];
  /**
   * Maps local pattern index to the alpha-2 ISO code the
   * pattern resolves to. Used for downstream coreference /
   * placeholder grouping.
   */
  isoCodes: string[];
  /** Maps local pattern index to pattern variant kind. */
  variants: CountryVariant[];
};

export type CountryVariant = "name" | "alias" | "alpha3" | "alpha2";

type RawCountryData = {
  codes: { alpha2: string[]; alpha3: string[] };
  names: Record<string, Record<string, string>>;
  aliases: Record<string, string[]>;
};

/**
 * Build country patterns for the literal search instance.
 * Returns patterns and parallel metadata arrays.
 *
 * Patterns are literal, case-insensitive, whole-word.
 * Each unique surface form appears once, keyed by its
 * resolved alpha-2 code so duplicate surface forms (e.g.,
 * "Georgia" the US state vs. the country) collapse to the
 * country entry.
 */
export const buildCountryPatterns = (): {
  patterns: PatternEntry[];
  data: CountryData;
} => {
  const raw = countriesData as RawCountryData;

  // Map surface form (lowercased) → { isoCode, variant }.
  // First writer wins so name beats alias beats alpha3.
  const surfaceToMeta = new Map<
    string,
    { display: string; isoCode: string; variant: CountryVariant }
  >();

  const register = (
    surface: string,
    isoCode: string,
    variant: CountryVariant,
  ) => {
    const trimmed = surface.trim();
    if (trimmed.length === 0) return;
    // The unified literal search runs against
    // `normalizeForSearch(fullText)`, which rewrites NBSP / smart
    // quotes / en–em-dashes to their ASCII equivalents. CLDR
    // ships names with en-dashes ("Kongo – Kinshasa", "Hongkong –
    // ZAO Číny") and smart apostrophes; without the same
    // normalization on the pattern side those names would never
    // match real input. Replacements are same-length, so match
    // offsets in the original text stay valid.
    const normalized = normalizeForSearch(trimmed);
    const key = normalized.toLowerCase();
    if (NAME_BLOCKLIST.has(key)) return;
    if (!surfaceToMeta.has(key)) {
      surfaceToMeta.set(key, { display: normalized, isoCode, variant });
    }
    // Typographic-apostrophe variants. CLDR ships only the
    // curly form ("Côte d’Ivoire"); legal/OCR text routinely
    // uses the straight one ("Côte d'Ivoire"). Register both
    // so either renders match.
    if (trimmed.includes("’") || trimmed.includes("‘")) {
      const straight = normalizeForSearch(trimmed.replaceAll(/[‘’]/g, "'"));
      const straightKey = straight.toLowerCase();
      if (!surfaceToMeta.has(straightKey)) {
        surfaceToMeta.set(straightKey, {
          display: straight,
          isoCode,
          variant,
        });
      }
    }
  };

  // Canonical names per language, keyed by alpha-2 code.
  for (const perLang of Object.values(raw.names)) {
    for (const [code, name] of Object.entries(perLang)) {
      register(name, code, "name");
    }
  }

  // Curated aliases.
  for (const [isoCode, aliases] of Object.entries(raw.aliases)) {
    for (const alias of aliases) {
      register(alias, isoCode, "alias");
    }
  }

  // Alpha-3 (opt-in only; too many case-insensitive
  // collisions with common words — see INCLUDE_ALPHA3).
  if (INCLUDE_ALPHA3) {
    for (let i = 0; i < raw.codes.alpha2.length; i++) {
      const a2 = raw.codes.alpha2[i];
      const a3 = raw.codes.alpha3[i];
      if (a2 && a3) register(a3, a2, "alpha3");
    }
  }

  // Alpha-2 (opt-in only; too many false positives).
  if (INCLUDE_ALPHA2) {
    for (const code of raw.codes.alpha2) {
      register(code, code, "alpha2");
    }
  }

  const patterns: PatternEntry[] = [];
  const labels: string[] = [];
  const isoCodes: string[] = [];
  const variants: CountryVariant[] = [];

  for (const { display, isoCode, variant } of surfaceToMeta.values()) {
    patterns.push({
      pattern: display,
      literal: true,
      wholeWords: true,
    });
    labels.push(ENTITY_LABEL);
    isoCodes.push(isoCode);
    variants.push(variant);
  }

  return { patterns, data: { labels, isoCodes, variants } };
};

/**
 * Whether the match starts on a proper-noun character.
 * The unified literal search is case-insensitive, so
 * lowercase common nouns that share spelling with a
 * country name ("turkey" the bird, "china" the porcelain,
 * "jordan" the basketball player nickname) would otherwise
 * be flagged. CLDR canonical names and the curated alias
 * list are always proper nouns; require uppercase when the
 * first character is a letter so common-noun usage in
 * prose isn't redacted. Non-letter starts (digits in
 * "U.S.A.", etc.) are accepted as-is.
 */
const startsAsProperNoun = (text: string, start: number): boolean => {
  const ch = text.charAt(start);
  if (ch.length === 0) return false;
  const upper = ch.toUpperCase();
  const lower = ch.toLowerCase();
  // Non-letter character → no case to enforce.
  if (upper === lower) return true;
  return ch === upper;
};

/**
 * Convert raw country matches into Entity objects.
 * Filters to the country slice and emits one entity per
 * match. Score is constant (0.95) for all variants;
 * deterministic detector with no fuzzy paths.
 */
export const processCountryMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
  fullText: string,
  data: CountryData,
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) continue;

    const localIdx = idx - sliceStart;
    const label = data.labels[localIdx];
    if (!label) continue;

    if (!startsAsProperNoun(fullText, match.start)) continue;

    results.push({
      start: match.start,
      end: match.end,
      label,
      text: fullText.slice(match.start, match.end),
      score: EXACT_SCORE,
      source: DETECTION_SOURCES.COUNTRY,
    });
  }

  return results;
};
