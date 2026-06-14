import { describe, expect, test } from "bun:test";

import type { Entity } from "../../types";
import { boostNearMissEntities } from "../confidence-boost";

const entity = (start: number, end: number, score: number): Entity => ({
  start,
  end,
  label: "person",
  text: "x".repeat(Math.max(1, end - start)),
  score,
  source: "ner",
});

describe("boostNearMissEntities", () => {
  test("never boosts a score above 1.0", () => {
    // A near-miss surrounded by many confirmed neighbours inside
    // the context window. Each neighbour adds BOOST_PER_NEIGHBOUR
    // (0.05); with this many the raw boost exceeds 1.0 and must be
    // clamped to preserve the 0..1 score invariant.
    const threshold = 0.5;
    const nearMiss = entity(100, 105, 0.45); // within band [0.35, 0.5)

    const anchors: Entity[] = [];
    for (let i = 0; i < 30; i++) {
      // All within CONTEXT_WINDOW_CHARS (150) of the near-miss.
      anchors.push(entity(100 + i, 101 + i, 0.95));
    }

    const out = boostNearMissEntities([nearMiss, ...anchors], threshold);

    for (const e of out) {
      expect(e.score).toBeLessThanOrEqual(1);
      expect(e.score).toBeGreaterThanOrEqual(0);
    }

    // The near-miss was promoted (boost fired) and clamped to 1.
    const promoted = out.find((e) => e.start === 100 && e.end === 105);
    expect(promoted).toBeDefined();
    expect(promoted?.score).toBe(1);
  });
});
