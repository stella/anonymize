/**
 * Run the two-instance unified search and return
 * raw matches. Two passes instead of six:
 * 1. regex + triggers + legal-forms
 * 2. deny-list + street-types (normalized text)
 */

import type { Match } from "@stll/text-search";
import type { UnifiedSearchInstance } from "./build-unified-search";
import { normalizeForSearch } from "./util/normalize";

export type UnifiedResult = {
  /** All matches from both instances combined. */
  regexMatches: Match[];
  literalMatches: Match[];
};

export const runUnifiedSearch = (
  instance: UnifiedSearchInstance,
  fullText: string,
): UnifiedResult => {
  // Pass 1: regex + triggers + legal-forms
  // on original text (regex patterns encode
  // their own case flags)
  const regexMatches = instance.tsRegex.findIter(fullText);

  // Pass 2: deny-list + street-types on
  // normalized text (NBSP, smart quotes folded)
  const normalized = normalizeForSearch(fullText);
  const literalMatches = instance.tsLiterals.findIter(normalized);

  return { regexMatches, literalMatches };
};
