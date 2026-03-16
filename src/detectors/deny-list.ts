import { AhoCorasick } from "@monyone/aho-corasick";

import {
  ALL_DICTIONARY_IDS,
  DICTIONARY_META,
  loadDictionary,
} from "../dictionaries/index";
import type { DictionaryId } from "../dictionaries/index";
import { resolveCountries } from "../regions";
import { DETECTION_SOURCES } from "../types";
import type { Entity, PipelineConfig } from "../types";

export type DenyListConfig = Pick<
  PipelineConfig,
  | "enableDenyList"
  | "denyListCountries"
  | "denyListRegions"
  | "denyListExcludeCategories"
>;

const WORD_BOUNDARY_RE = /[\s\p{P}]/u;

const isWordBoundary = (text: string, pos: number): boolean => {
  if (pos <= 0 || pos >= text.length) {
    return true;
  }
  const before = text[pos - 1] ?? "";
  const after = text[pos] ?? "";
  return WORD_BOUNDARY_RE.test(before) || WORD_BOUNDARY_RE.test(after);
};

/**
 * Resolve which dictionaries to load based on country
 * and category filters, then load and merge them into
 * a Map<term, label>.
 */
export const loadDenyListTerms = async (
  config: DenyListConfig,
): Promise<Map<string, string>> => {
  const allowedCountries = resolveCountries(
    config.denyListRegions,
    config.denyListCountries,
  );

  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded ? new Set(excluded) : new Set<string>();

  const ids = ALL_DICTIONARY_IDS.filter((id: DictionaryId) => {
    const meta = DICTIONARY_META[id];

    if (excludeCategories.has(meta.category)) {
      return false;
    }

    if (allowedCountries === null) {
      return true;
    }

    if (meta.country === null) {
      return true;
    }

    return allowedCountries.has(meta.country);
  });

  const terms = new Map<string, string>();

  const results = await Promise.all(
    ids.map(async (id: DictionaryId) => {
      const entries = await loadDictionary(id);
      return { id, entries };
    }),
  );

  for (const { id, entries } of results) {
    const meta = DICTIONARY_META[id];
    for (const entry of entries) {
      terms.set(entry, meta.label);
    }
  }

  return terms;
};

/**
 * Scan text for deny list terms using Aho-Corasick
 * (case-insensitive). Checks word boundaries to avoid
 * partial matches inside longer words.
 */
export const scanDenyList = (
  fullText: string,
  terms: Map<string, string>,
): Entity[] => {
  const patterns = Array.from(terms.keys());

  if (patterns.length === 0) {
    return [];
  }

  const lowerPatterns = patterns.map((p) => p.toLowerCase());
  const lowerText = fullText.toLowerCase();

  const labelByLower = new Map<string, string>();
  for (const [term, label] of Array.from(terms)) {
    labelByLower.set(term.toLowerCase(), label);
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call
  const ac = new AhoCorasick(lowerPatterns);
  const results: Entity[] = [];

  // oxlint-disable-next-line typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
  for (const match of ac.matchInText(lowerText)) {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
    const begin: number = match.begin;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
    const end: number = match.end;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
    const keyword: string = match.keyword;

    if (!isWordBoundary(fullText, begin) || !isWordBoundary(fullText, end)) {
      continue;
    }

    const label = labelByLower.get(keyword);
    if (!label) {
      continue;
    }

    results.push({
      start: begin,
      end,
      label,
      text: fullText.slice(begin, end),
      score: 0.9,
      source: DETECTION_SOURCES.DENY_LIST,
    });
  }

  return results;
};
