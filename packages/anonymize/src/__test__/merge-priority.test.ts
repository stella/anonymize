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
    const trigger = makeEntity(
      "trigger",
      0.99,
      5,
      15,
    );
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

  test("legal-form and regex have equal priority", () => {
    const legalForm = makeEntity(
      "legal-form",
      0.88,
      0,
      12,
    );
    const regex = makeEntity("regex", 0.92, 0, 12);
    const result = mergeAndDedup([legalForm, regex]);
    expect(result).toHaveLength(1);
    // Same priority (3), so higher score wins
    expect(result[0]?.source).toBe("regex");
    expect(result[0]?.score).toBe(0.92);
  });
});
