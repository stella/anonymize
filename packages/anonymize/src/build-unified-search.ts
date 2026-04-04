/**
 * Build the unified search instances from all
 * detector pattern sources.
 *
 * Two TextSearch instances (not one) to avoid
 * 200K per-pattern object allocations:
 * 1. regex + triggers + legal-forms (mixed, ~140
 *    patterns, caseInsensitive for trigger AC)
 * 2. deny-list + street-types + gazetteer
 *    (caseInsensitive, overlap "all";
 *    deny-list/street-type use per-pattern
 *    wholeWords: true; gazetteer exact use
 *    wholeWords: false; gazetteer fuzzy use
 *    distance: 2 via @stll/fuzzy-search)
 *
 * All patterns are PatternEntry objects with
 * per-pattern literal/wholeWords settings.
 */

import type { PatternEntry, TextSearch } from "@stll/text-search";

import { getTextSearch } from "./search-engine";

import {
  isLegalFormsEnabled,
  type GazetteerEntry,
  type PipelineConfig,
} from "./types";
import type { RegexMeta } from "./detectors/regex";
import type { TriggerRule } from "./types";
import type { DenyListData } from "./detectors/deny-list";
import type { PipelineContext } from "./context";
import { defaultContext } from "./context";

import {
  REGEX_PATTERNS,
  REGEX_META,
  getCurrencyPatterns,
  CURRENCY_PATTERN_META,
  getDatePatterns,
  DATE_PATTERN_META,
  getSigningClausePatterns,
  SIGNING_CLAUSE_META,
} from "./detectors/regex";
import { buildLegalFormPatterns } from "./detectors/legal-forms";
import { buildTriggerPatterns } from "./detectors/triggers";
import { buildDenyList } from "./detectors/deny-list";
import { buildStreetTypePatterns } from "./detectors/address-seeds";
import { buildGazetteerPatterns } from "./detectors/gazetteer";

type PatternSlice = {
  start: number;
  end: number;
};

export type GazetteerData = {
  /** Maps local pattern index to entry label. */
  labels: string[];
  /**
   * Whether each pattern is fuzzy (distance > 0).
   * Used by the post-processor to assign scores.
   */
  isFuzzy: boolean[];
};

export type UnifiedSearchInstance = {
  /** Regex + triggers + legal-forms. */
  tsRegex: TextSearch;
  /** Deny-list + street-types + gazetteer. */
  tsLiterals: TextSearch;
  slices: {
    regex: PatternSlice;
    legalForms: PatternSlice;
    triggers: PatternSlice;
    denyList: PatternSlice;
    streetTypes: PatternSlice;
    gazetteer: PatternSlice;
  };
  regexMeta: readonly RegexMeta[];
  triggerRules: readonly TriggerRule[];
  denyListData: DenyListData | null;
  gazetteerData: GazetteerData | null;
};

export const buildUnifiedSearch = async (
  config: PipelineConfig,
  gazetteerEntries: GazetteerEntry[] = [],
  ctx: PipelineContext = defaultContext,
): Promise<UnifiedSearchInstance> => {
  const legalFormsEnabled = isLegalFormsEnabled(config);
  const [
    legalForms,
    triggers,
    denyListData,
    streetTypes,
    currencyPatterns,
    datePatterns,
    signingPatterns,
  ] = await Promise.all([
    legalFormsEnabled
      ? buildLegalFormPatterns()
      : Promise.resolve([] as string[]),
    config.enableTriggerPhrases
      ? buildTriggerPatterns()
      : Promise.resolve({
          patterns: [] as string[],
          rules: [] as TriggerRule[],
        }),
    config.enableDenyList ? buildDenyList(config, ctx) : Promise.resolve(null),
    buildStreetTypePatterns(),
    getCurrencyPatterns(),
    getDatePatterns(),
    getSigningClausePatterns(),
  ]);

  // ── Instance 1: regex + triggers + legal-forms ──
  // Trigger patterns are lowercased strings with
  // caseInsensitive on the AC. Regex patterns have
  // their own (?i) flags (caseInsensitive on AC
  // is ignored for regex since they route to
  // RegexSet). Legal-form patterns are regex too.
  //
  // Currency patterns (from currencies.json) are
  // appended after the static regex patterns; their
  // meta is spliced into regexMeta at the same offset.
  const allRegex = [
    ...(REGEX_PATTERNS as string[]),
    ...currencyPatterns,
    ...datePatterns,
    ...signingPatterns,
  ];
  const regexMeta: RegexMeta[] = [
    ...REGEX_META,
    ...currencyPatterns.map(() => CURRENCY_PATTERN_META),
    ...datePatterns.map(() => DATE_PATTERN_META),
    ...signingPatterns.map(() => SIGNING_CLAUSE_META),
  ];

  let offset = 0;

  const regexSlice = {
    start: offset,
    end: offset + allRegex.length,
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
  const triggerEntries = triggers.patterns.map((p) => ({
    pattern: p,
    literal: true as const,
    caseInsensitive: true,
  }));

  const regexAllPatterns = [...allRegex, ...legalForms, ...triggerEntries];

  // TextSearch auto-detects DFA state explosion
  // (build time > 2ms) and falls back to individual
  // engines. No manual maxAlternations needed.
  const tsRegex = new (getTextSearch())(regexAllPatterns);

  // ── Instance 2: deny-list + street-types + gaz ──
  // Deny-list and street-type patterns are plain
  // strings (allLiteral). Gazetteer adds exact
  // literals plus fuzzy PatternEntry objects for
  // terms >= 4 chars.
  offset = 0;

  const denyListOriginals = denyListData?.originals ?? [];
  const denyListSlice = {
    start: offset,
    end: offset + denyListOriginals.length,
  };
  offset = denyListSlice.end;

  const streetTypesSlice = {
    start: offset,
    end: offset + streetTypes.length,
  };
  offset = streetTypesSlice.end;

  // Gazetteer patterns (exact + fuzzy)
  const gazResult =
    config.enableGazetteer && gazetteerEntries.length > 0
      ? buildGazetteerPatterns(gazetteerEntries)
      : null;

  const gazetteerSlice = {
    start: offset,
    end: offset + (gazResult?.patterns.length ?? 0),
  };
  offset = gazetteerSlice.end;

  // Build the combined pattern array.
  // Deny-list and street-type patterns use
  // per-pattern wholeWords: true (they are
  // known tokens). Gazetteer exact patterns
  // already set wholeWords: false in
  // buildGazetteerPatterns. The global
  // wholeWords is false so fuzzy patterns
  // (which don't support per-pattern override)
  // match without word-boundary constraints.
  const wrapWholeWord = (s: string): PatternEntry => ({
    pattern: s,
    literal: true as const,
    wholeWords: true,
  });
  const literalAllPatterns: PatternEntry[] = [
    ...denyListOriginals.map(wrapWholeWord),
    ...streetTypes.map(wrapWholeWord),
    ...(gazResult?.patterns ?? []),
  ];

  const tsLiterals =
    literalAllPatterns.length > 0
      ? new (getTextSearch())(literalAllPatterns, {
          caseInsensitive: true,
          overlapStrategy: "all",
        })
      : new (getTextSearch())([]);

  return {
    tsRegex,
    tsLiterals,
    slices: {
      regex: regexSlice,
      legalForms: legalFormsSlice,
      triggers: triggersSlice,
      denyList: denyListSlice,
      streetTypes: streetTypesSlice,
      gazetteer: gazetteerSlice,
    },
    regexMeta,
    triggerRules: triggers.rules,
    denyListData,
    gazetteerData: gazResult?.data ?? null,
  };
};
