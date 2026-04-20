import type { Match, PatternEntry } from "@stll/text-search";

import { getTextSearch } from "../search-engine";
import type { Entity } from "../types";

// ── Types ───────────────────────────────────────────

export type HotwordRule = {
  hotwords: string[];
  targetLabels: string[];
  scoreAdjustment: number;
  reclassifyTo?: string;
  proximityBefore: number;
  proximityAfter: number;
};

type HotwordRulesConfig = {
  rules: HotwordRule[];
};

// ── Lazy-loaded state ───────────────────────────────

let rules: HotwordRule[] | null = null;
let search: { findIter: (text: string) => Match[] } | null = null;
/**
 * Maps each TextSearch pattern index back to the
 * rule index that owns it, so a single AC scan
 * resolves all hotword hits to their rule.
 */
let patternToRule: number[] | null = null;
let initPromise: Promise<void> | null = null;

// ── Init ────────────────────────────────────────────

const loadRules = async (): Promise<void> => {
  const mod = await import("../data/hotword-rules.json");
  const data: HotwordRulesConfig = mod.default ?? mod;
  const loaded = data.rules;

  // Build a flat pattern list and the reverse map.
  const patterns: PatternEntry[] = [];
  const mapping: number[] = [];

  for (let ruleIdx = 0; ruleIdx < loaded.length; ruleIdx++) {
    const rule = loaded[ruleIdx];
    if (!rule) continue;
    for (const hw of rule.hotwords) {
      patterns.push({
        pattern: hw,
        literal: true,
        caseInsensitive: true,
      });
      mapping.push(ruleIdx);
    }
  }

  const builtSearch =
    patterns.length > 0
      ? new (getTextSearch())(patterns, {
          overlapStrategy: "all",
          caseInsensitive: true,
          wholeWords: true,
        })
      : null;

  // Assign all module state atomically after all
  // failable operations succeed, so a mid-flight
  // error cannot leave a half-initialized state.
  patternToRule = mapping;
  search = builtSearch;
  rules = loaded;
};

/**
 * Load hotword rules from the data package.
 * Safe to call multiple times; subsequent calls
 * are no-ops.
 */
export const initHotwordRules = async (): Promise<void> => {
  if (rules !== null) return;
  if (initPromise !== null) return initPromise;
  initPromise = loadRules().catch((err) => {
    // Reset so callers can retry on transient failure.
    initPromise = null;
    throw err;
  });
  return initPromise;
};

/**
 * Expand requested output labels with any source labels
 * that hotword rules may reclassify into them.
 *
 * Example: requesting only "date of birth" still needs
 * "date" candidates to survive until the hotword pass.
 * If rules are not initialized, or if no labels were
 * requested, returns the input labels unchanged.
 */
export const expandLabelsForHotwordRules = (
  requestedLabels: readonly string[],
): readonly string[] => {
  if (rules === null || requestedLabels.length === 0) {
    return requestedLabels;
  }

  const requested = new Set(requestedLabels);
  const expanded = new Set(requestedLabels);

  for (const rule of rules) {
    if (rule.reclassifyTo === undefined || !requested.has(rule.reclassifyTo)) {
      continue;
    }
    for (const label of rule.targetLabels) {
      expanded.add(label);
    }
  }

  return [...expanded];
};

// ── Application ─────────────────────────────────────

/**
 * Apply hotword context rules to detected entities.
 *
 * Scans `fullText` once with a single AC automaton
 * for all hotwords across all rules, then checks
 * proximity to each entity. Distance-decayed
 * adjustment: closer hotwords give a stronger boost.
 *
 * Returns a new array; input entities are not mutated.
 */
export const applyHotwordRules = (
  entities: Entity[],
  fullText: string,
): Entity[] => {
  if (
    rules === null ||
    rules.length === 0 ||
    search === null ||
    patternToRule === null
  ) {
    return entities;
  }

  // Single scan for all hotword positions.
  const hits = search.findIter(fullText);
  if (hits.length === 0) return entities;

  // Group hits by rule index for fast lookup.
  const hitsByRule = new Map<number, Match[]>();
  for (const hit of hits) {
    const ruleIdx = patternToRule[hit.pattern];
    if (ruleIdx === undefined) continue;
    let bucket = hitsByRule.get(ruleIdx);
    if (bucket === undefined) {
      bucket = [];
      hitsByRule.set(ruleIdx, bucket);
    }
    bucket.push(hit);
  }

  const result: Entity[] = [];

  for (const entity of entities) {
    let bestAdjustment = 0;
    let bestReclassify: string | undefined;

    for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
      const rule = rules[ruleIdx];
      if (!rule) continue;

      // Check if entity label matches this rule.
      if (!rule.targetLabels.includes(entity.label)) {
        continue;
      }

      const ruleHits = hitsByRule.get(ruleIdx);
      if (ruleHits === undefined) continue;

      for (const hit of ruleHits) {
        // Asymmetric proximity check.
        // Hotword BEFORE entity: hotword end <=
        //   entity start, distance = entity.start -
        //   hit.end
        // Hotword AFTER entity: hotword start >=
        //   entity end, distance = hit.start -
        //   entity.end
        let distance: number;
        let maxDistance: number;

        if (hit.end <= entity.start) {
          // Hotword is before the entity.
          distance = entity.start - hit.end;
          maxDistance = rule.proximityBefore;
        } else if (hit.start >= entity.end) {
          // Hotword is after the entity.
          distance = hit.start - entity.end;
          maxDistance = rule.proximityAfter;
        } else {
          // Hotword overlaps the entity: distance 0,
          // use larger window for max.
          distance = 0;
          maxDistance = Math.max(rule.proximityBefore, rule.proximityAfter);
        }

        if (distance > maxDistance) continue;

        // Distance-decayed adjustment.
        const decay = maxDistance === 0 ? 1 : 1 - distance / maxDistance;
        const adj = rule.scoreAdjustment * decay;

        if (Math.abs(adj) > Math.abs(bestAdjustment)) {
          bestAdjustment = adj;
          // Only carry reclassification from boost
          // rules; a penalty winner must not silently
          // overwrite a label set by a closer positive
          // rule.
          if (adj > 0) {
            bestReclassify = rule.reclassifyTo;
          } else {
            bestReclassify = undefined;
          }
        }
      }
    }

    if (bestAdjustment === 0) {
      result.push(entity);
      continue;
    }

    const newScore = Math.min(1, Math.max(0, entity.score + bestAdjustment));
    const newLabel =
      bestReclassify !== undefined ? bestReclassify : entity.label;

    result.push({
      ...entity,
      score: newScore,
      label: newLabel,
    });
  }

  return result;
};
