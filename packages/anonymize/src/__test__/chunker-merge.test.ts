import { describe, expect, test } from "bun:test";
import type { Entity } from "../types";
import { mergeChunkEntities } from "../util/chunker";

const entity = (
  start: number,
  end: number,
  score: number,
  label = "PERSON",
  source: Entity["source"] = "gliner",
): Entity => ({
  start,
  end,
  label,
  text: `text_${start}_${end}`,
  score,
  source,
});

describe("mergeChunkEntities", () => {
  test("empty input returns empty", () => {
    expect(mergeChunkEntities([], [])).toEqual([]);
  });

  test(
    "non-overlapping entities from different chunks"
      + " pass through",
    () => {
      const chunk0 = [entity(0, 5, 0.9)];
      const chunk1 = [entity(0, 8, 0.85)];
      // chunk1 offset = 100 → entity at [100, 108]
      const result = mergeChunkEntities(
        [0, 100],
        [chunk0, chunk1],
      );
      expect(result).toHaveLength(2);
      expect(result[0]?.start).toBe(0);
      expect(result[1]?.start).toBe(100);
    },
  );

  test(
    "near-duplicate entities (same label, similar"
      + " position) are deduped",
    () => {
      // Simulate overlap: two chunks produce entities
      // at nearly the same document-level position.
      const chunk0 = [entity(90, 100, 0.8)];
      const chunk1 = [entity(0, 10, 0.75)];
      // chunk1 offset = 92 → entity at [92, 102],
      // which is within 5 of [90, 100].
      const result = mergeChunkEntities(
        [0, 92],
        [chunk0, chunk1],
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.score).toBe(0.8);
      expect(result[0]?.start).toBe(90);
      expect(result[0]?.end).toBe(100);
    },
  );

  test(
    "different-label entities at same position"
      + " are kept",
    () => {
      const chunk0 = [entity(10, 20, 0.9, "PERSON")];
      const chunk1 = [entity(0, 10, 0.9, "ORG")];
      // chunk1 offset = 10 → entity at [10, 20],
      // same position but different label.
      const result = mergeChunkEntities(
        [0, 10],
        [chunk0, chunk1],
      );
      expect(result).toHaveLength(2);
      const labels = result.map((e) => e.label);
      expect(labels).toContain("PERSON");
      expect(labels).toContain("ORG");
    },
  );

  test("higher score wins in dedup", () => {
    const chunk0 = [entity(50, 60, 0.7)];
    const chunk1 = [entity(0, 10, 0.95)];
    // chunk1 offset = 51 → entity at [51, 61],
    // within threshold of [50, 60].
    const result = mergeChunkEntities(
      [0, 51],
      [chunk0, chunk1],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.95);
    expect(result[0]?.start).toBe(51);
    expect(result[0]?.end).toBe(61);
  });

  test("skips empty chunk results", () => {
    const result = mergeChunkEntities(
      [0, 100],
      [[], [entity(0, 5, 0.9)]],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe(100);
  });

  test(
    "replacement preserves sorted invariant"
      + " (regression: mixed labels + score upgrade)",
    () => {
      // Devin review scenario: A(50-60 PERSON 0.7),
      // B(50-60 ORG 0.8), C(54-64 PERSON 0.9),
      // D(56-66 PERSON 0.85).
      // C dedup-replaces A; D must still dedup with C.
      const result = mergeChunkEntities(
        [0],
        [
          [
            entity(50, 60, 0.7, "PERSON"),
            entity(50, 60, 0.8, "ORG"),
            entity(54, 64, 0.9, "PERSON"),
            entity(56, 66, 0.85, "PERSON"),
          ],
        ],
      );
      const persons = result.filter(
        (e) => e.label === "PERSON",
      );
      const orgs = result.filter(
        (e) => e.label === "ORG",
      );
      // Only one PERSON should survive (score 0.9).
      expect(persons).toHaveLength(1);
      expect(persons[0]?.score).toBe(0.9);
      expect(persons[0]?.start).toBe(54);
      expect(persons[0]?.end).toBe(64);
      // ORG is distinct, kept separately.
      expect(orgs).toHaveLength(1);
      expect(orgs[0]?.score).toBe(0.8);
    },
  );
});
