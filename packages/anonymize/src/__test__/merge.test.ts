import { describe, expect, test } from "bun:test";
import { mergeAndDedup } from "../pipeline";
import type { Entity } from "../types";

const entity = (
  start: number,
  end: number,
  score: number,
  label = "PERSON",
  source: Entity["source"] = "regex",
): Entity => ({
  start,
  end,
  label,
  text: `text_${start}_${end}`,
  score,
  source,
});

describe("mergeAndDedup", () => {
  test("empty input returns empty", () => {
    expect(mergeAndDedup([])).toEqual([]);
    expect(mergeAndDedup()).toEqual([]);
    expect(mergeAndDedup([], [])).toEqual([]);
  });

  test("single entity returns itself", () => {
    const e = entity(0, 5, 0.9);
    const result = mergeAndDedup([e]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(5);
  });

  test("non-overlapping entities pass through", () => {
    const a = entity(0, 5, 0.9);
    const b = entity(10, 15, 0.8);
    const c = entity(20, 25, 0.7);
    const result = mergeAndDedup([a, b, c]);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.start)).toEqual([0, 10, 20]);
  });

  test("adjacent non-overlapping entities are kept", () => {
    // end === start means no overlap
    const a = entity(0, 5, 0.9);
    const b = entity(5, 10, 0.8);
    const result = mergeAndDedup([a, b]);
    expect(result).toHaveLength(2);
  });

  test("overlapping entities: higher score wins", () => {
    const low = entity(0, 10, 0.5);
    const high = entity(3, 8, 0.9);
    const result = mergeAndDedup([low, high]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].start).toBe(3);
  });

  test("overlapping entities: same score, longer wins", () => {
    const short = entity(2, 6, 0.8);
    const long = entity(0, 10, 0.8);
    const result = mergeAndDedup([short, long]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(10);
  });

  test("overlapping entities: same score, longer wins when it arrives second", () => {
    // short=[0,4] enters merged first; long=[2,12]
    // must actively replace it via shouldReplace
    const short = entity(0, 4, 0.8);
    const long = entity(2, 12, 0.8);
    const result = mergeAndDedup([short, long]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(2);
    expect(result[0].end).toBe(12);
  });

  test("overlapping entities: lower score is dropped", () => {
    const high = entity(0, 10, 0.9);
    const low = entity(3, 8, 0.5);
    const result = mergeAndDedup([high, low]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  test("3-way overlap keeps best entity", () => {
    const a = entity(0, 10, 0.5);
    const b = entity(5, 15, 0.9);
    const c = entity(8, 20, 0.7);
    const result = mergeAndDedup([a, b, c]);
    // a overlaps b: b wins (higher score)
    // c overlaps b: b wins (higher score)
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].start).toBe(5);
  });

  test("chain replacement: each winner evicts the previous tail", () => {
    // sorted: [0,10,0.5] → [3,12,0.7] → [8,15,0.9]
    // [3,12] beats [0,10]; [8,15] beats [3,12]
    const a = entity(0, 10, 0.5);
    const b = entity(3, 12, 0.7);
    const c = entity(8, 15, 0.9);
    const result = mergeAndDedup([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].start).toBe(8);
  });

  test("multiple layers are flattened", () => {
    const layer1 = [entity(0, 5, 0.9)];
    const layer2 = [entity(10, 15, 0.8)];
    const result = mergeAndDedup(layer1, layer2);
    expect(result).toHaveLength(2);
  });

  test("result is sorted by start position", () => {
    const a = entity(20, 25, 0.9);
    const b = entity(0, 5, 0.8);
    const c = entity(10, 15, 0.7);
    const result = mergeAndDedup([a, b, c]);
    expect(result.map((e) => e.start)).toEqual([0, 10, 20]);
  });

  test("entities are shallow-copied", () => {
    const original = entity(0, 5, 0.9);
    const result = mergeAndDedup([original]);
    expect(result[0]).not.toBe(original);
    expect(result[0].start).toBe(original.start);
  });
});
