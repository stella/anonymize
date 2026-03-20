/**
 * Build the unified search instances from all
 * detector pattern sources.
 *
 * Two TextSearch instances (not one) to avoid
 * 200K per-pattern object allocations:
 * 1. regex + triggers + legal-forms (mixed, ~140
 *    patterns, caseInsensitive for trigger AC)
 * 2. deny-list + street-types (200K literals,
 *    caseInsensitive + wholeWords + overlap "all")
 *
 * Plain strings, zero PatternEntry objects.
 */

import { TextSearch } from "@stll/text-search";

import type { PipelineConfig } from "./types";
import type { RegexMeta } from "./detectors/regex";
import type { TriggerRule } from "./types";
import type { DenyListData } from "./detectors/deny-list";

import {
  REGEX_PATTERNS,
  REGEX_META,
} from "./detectors/regex";
import {
  buildLegalFormPatterns,
} from "./detectors/legal-forms";
import {
  buildTriggerPatterns,
} from "./detectors/triggers";
import {
  buildDenyList,
} from "./detectors/deny-list";
import {
  buildStreetTypePatterns,
} from "./detectors/address-seeds";

type PatternSlice = {
  start: number;
  end: number;
};

export type UnifiedSearchInstance = {
  /** Regex + triggers + legal-forms. */
  tsRegex: TextSearch;
  /** Deny-list + street-types. */
  tsLiterals: TextSearch;
  slices: {
    regex: PatternSlice;
    legalForms: PatternSlice;
    triggers: PatternSlice;
    denyList: PatternSlice;
    streetTypes: PatternSlice;
  };
  regexMeta: readonly RegexMeta[];
  triggerRules: readonly TriggerRule[];
  denyListData: DenyListData | null;
};

export const buildUnifiedSearch = async (
  config: PipelineConfig,
): Promise<UnifiedSearchInstance> => {
  const [
    legalForms,
    triggers,
    denyListData,
    streetTypes,
  ] = await Promise.all([
    buildLegalFormPatterns(),
    config.enableTriggerPhrases
      ? buildTriggerPatterns()
      : Promise.resolve({
          patterns: [] as string[],
          rules: [] as TriggerRule[],
        }),
    config.enableDenyList
      ? buildDenyList(config)
      : Promise.resolve(null),
    buildStreetTypePatterns(),
  ]);

  // ── Instance 1: regex + triggers + legal-forms ──
  // Trigger patterns are lowercased strings with
  // caseInsensitive on the AC. Regex patterns have
  // their own (?i) flags (caseInsensitive on AC
  // is ignored for regex since they route to
  // RegexSet). Legal-form patterns are regex too.
  let offset = 0;

  const regexSlice = {
    start: offset,
    end: offset + REGEX_PATTERNS.length,
  };
  offset = regexSlice.end;

  const legalFormsSlice = {
    start: offset,
    end: offset + legalForms.length,
  };
  offset = legalFormsSlice.end;

  const triggersSlice = {
    start: offset,
    end: offset + triggers.patterns.length,
  };

  // Trigger patterns need caseInsensitive on AC
  // (only ~120 objects, not 200K). Regex/legal-form
  // patterns are bare strings (auto-classified).
  const triggerEntries = triggers.patterns.map(
    (p) => ({
      pattern: p,
      literal: true as const,
      caseInsensitive: true,
    }),
  );

  const regexAllPatterns = [
    ...(REGEX_PATTERNS as string[]),
    ...legalForms,
    ...triggerEntries,
  ];

  // TextSearch auto-detects DFA state explosion
  // (build time > 2ms) and falls back to individual
  // engines. No manual maxAlternations needed.
  const tsRegex = new TextSearch(regexAllPatterns);

  // ── Instance 2: deny-list + street-types ────────
  // All literals, passed as plain strings.
  // Zero PatternEntry object allocation.
  offset = 0;

  const denyListOriginals =
    denyListData?.originals ?? [];
  const denyListSlice = {
    start: offset,
    end: offset + denyListOriginals.length,
  };
  offset = denyListSlice.end;

  const streetTypesSlice = {
    start: offset,
    end: offset + streetTypes.length,
  };

  const literalAllPatterns: string[] = [
    ...denyListOriginals,
    ...streetTypes,
  ];

  const tsLiterals =
    literalAllPatterns.length > 0
      ? new TextSearch(literalAllPatterns, {
          allLiteral: true,
          caseInsensitive: true,
          wholeWords: true,
          overlapStrategy: "all",
        })
      : new TextSearch([]);

  return {
    tsRegex,
    tsLiterals,
    slices: {
      regex: regexSlice,
      legalForms: legalFormsSlice,
      triggers: triggersSlice,
      denyList: denyListSlice,
      streetTypes: streetTypesSlice,
    },
    regexMeta: REGEX_META,
    triggerRules: triggers.rules,
    denyListData,
  };
};
