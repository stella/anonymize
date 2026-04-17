import { describe, expect, test } from "bun:test";

import { mergeAndDedup } from "../pipeline";
import type { DetectionSource, Entity } from "../types";

const makeEntity = (
  source: DetectionSource,
  score: number,
  start: number,
  end: number,
  label = "person",
): Entity => ({
  start,
  end,
  label,
  text: "x".repeat(end - start),
  score,
  source,
});

describe("mergeAndDedup priority resolution", () => {
  test("trigger beats NER at same span", () => {
    const ner = makeEntity("ner", 0.96, 0, 10);
    const trigger = makeEntity("trigger", 0.9, 0, 10);
    const result = mergeAndDedup([ner, trigger]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("trigger");
  });

  test("gazetteer beats everything", () => {
    const gaz = makeEntity("gazetteer", 0.8, 5, 15);
    const trigger = makeEntity("trigger", 0.99, 5, 15);
    const ner = makeEntity("ner", 0.99, 5, 15);
    const result = mergeAndDedup([ner, trigger, gaz]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("gazetteer");
  });

  test("same priority falls back to score", () => {
    const regex1 = makeEntity("regex", 0.85, 0, 8);
    const regex2 = makeEntity("regex", 0.92, 0, 8);
    const result = mergeAndDedup([regex1, regex2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.92);
  });

  test("same priority + same score uses span length", () => {
    const short = makeEntity("ner", 0.9, 0, 5);
    const long = makeEntity("ner", 0.9, 0, 10);
    const result = mergeAndDedup([short, long]);
    expect(result).toHaveLength(1);
    expect(result[0]?.end).toBe(10);
  });

  test("high-priority entity swallows two adjacent lower-priority entities", () => {
    // Two non-overlapping NER entities
    const ner1 = makeEntity("ner", 0.95, 0, 10);
    const ner2 = makeEntity("ner", 0.95, 10, 20);
    // One trigger that overlaps both
    const trigger = makeEntity("trigger", 0.7, 5, 15);
    const result = mergeAndDedup([ner1, ner2, trigger]);
    // Trigger replaces ner1 (overlaps [0,10]&[5,15]),
    // then ner2 overlaps trigger and loses on priority
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("trigger");
  });

  test("deny-list vs coreference at same priority falls back to score", () => {
    const deny = makeEntity("deny-list", 0.85, 0, 8);
    const coref = makeEntity("coreference", 0.9, 0, 8);
    const result = mergeAndDedup([deny, coref]);
    expect(result).toHaveLength(1);
    // Same priority (2), higher score wins
    expect(result[0]?.source).toBe("coreference");
    expect(result[0]?.score).toBe(0.9);
  });

  test("legal-form and regex have equal priority", () => {
    const legalForm = makeEntity("legal-form", 0.88, 0, 12);
    const regex = makeEntity("regex", 0.92, 0, 12);
    const result = mergeAndDedup([legalForm, regex]);
    expect(result).toHaveLength(1);
    // Same priority (3), so higher score wins
    expect(result[0]?.source).toBe("regex");
    expect(result[0]?.score).toBe(0.92);
  });

  test("longer deny-list beats contained regex with same label", () => {
    // "656 91 Brno" (deny-list, [0,11]) fully contains
    // "656 91" (regex, [0,6]). Same label: postal code.
    // Deny-list has lower priority (2 vs 3) but the
    // containment rule should prefer the longer entity.
    const regex = makeEntity("regex", 1, 0, 6, "postal code");
    const denyList = makeEntity("deny-list", 1, 0, 11, "postal code");
    const result = mergeAndDedup([regex, denyList]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("deny-list");
    expect(result[0]?.end).toBe(11);
  });

  test("containment rule does not override score for same source", () => {
    // Two regex entities with same label, one contained
    // in the other. Higher score should still win even
    // though the container is longer.
    const outer = makeEntity("regex", 0.5, 0, 10);
    const inner = makeEntity("regex", 0.9, 3, 8);
    const result = mergeAndDedup([outer, inner]);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.9);
  });

  test("containment rule only applies to literal sources", () => {
    // A longer regex/trigger should NOT override a
    // higher-priority shorter trigger via containment.
    // Only deny-list and gazetteer are trusted for the
    // "longer = more specific" heuristic.
    const trigger = makeEntity("trigger", 0.95, 0, 25, "address");
    const regex = makeEntity("regex", 0.75, 0, 50, "address");
    const result = mergeAndDedup([trigger, regex]);
    expect(result).toHaveLength(1);
    // Trigger has higher priority (4 > 3), should win
    expect(result[0]?.source).toBe("trigger");
  });
});
