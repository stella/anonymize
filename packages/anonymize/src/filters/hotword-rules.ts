import { TextSearch } from "@stll/text-search";
import type { Match, PatternEntry } from "@stll/text-search";
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
let search: TextSearch | null = null;
/**
 * Maps each TextSearch pattern index back to the
 * rule index that owns it, so a single AC scan
 * resolves all hotword hits to their rule.
 */
let patternToRule: number[] | null = null;
let initPromise: Promise<void> | null = null;

// ── Init ────────────────────────────────────────────

const loadRules = async (): Promise<void> => {
  const mod = await import(
    "@stll/anonymize-data/config/hotword-rules.json"
  );
  const data: HotwordRulesConfig = mod.default ?? mod;
  rules = data.rules;

  // Build a flat pattern list and the reverse map.
  const patterns: PatternEntry[] = [];
  const mapping: number[] = [];

  for (
    let ruleIdx = 0;
    ruleIdx < rules.length;
    ruleIdx++
  ) {
    for (const hw of rules[ruleIdx].hotwords) {
      patterns.push({
        pattern: hw,
        literal: true,
        caseInsensitive: true,
      });
      mapping.push(ruleIdx);
    }
  }

  patternToRule = mapping;
  search =
    patterns.length > 0
      ? new TextSearch(patterns, {
          overlapStrategy: "all",
          caseInsensitive: true,
        })
      : null;
};

/**
 * Load hotword rules from the data package.
 * Safe to call multiple times; subsequent calls
 * are no-ops.
 */
export const initHotwordRules =
  async (): Promise<void> => {
    if (rules !== null) return;
    if (initPromise !== null) return initPromise;
    initPromise = loadRules();
    return initPromise;
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

    for (
      let ruleIdx = 0;
      ruleIdx < rules.length;
      ruleIdx++
    ) {
      const rule = rules[ruleIdx];

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
          maxDistance = Math.max(
            rule.proximityBefore,
            rule.proximityAfter,
          );
        }

        if (distance > maxDistance) continue;

        // Distance-decayed adjustment.
        const decay = 1 - distance / maxDistance;
        const adj = rule.scoreAdjustment * decay;

        if (Math.abs(adj) > Math.abs(bestAdjustment)) {
          bestAdjustment = adj;
          bestReclassify = rule.reclassifyTo;
        }
      }
    }

    if (bestAdjustment === 0) {
      result.push(entity);
      continue;
    }

    const newScore = Math.min(
      1,
      Math.max(0, entity.score + bestAdjustment),
    );
    const newLabel =
      bestReclassify !== undefined
        ? bestReclassify
        : entity.label;

    result.push({
      ...entity,
      score: newScore,
      label: newLabel,
    });
  }

  return result;
};
