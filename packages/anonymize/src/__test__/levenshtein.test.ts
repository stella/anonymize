import { describe, expect, test } from "bun:test";

import { levenshtein } from "../util/levenshtein";

const SAMPLES = [
  "",
  "a",
  "abc",
  "kitten",
  "sitting",
  "Novák",
  "Nováková",
  "alice@example.com",
];

describe("levenshtein", () => {
  test("identity is zero", () => {
    for (const s of SAMPLES) {
      expect(levenshtein(s, s)).toBe(0);
    }
  });

  test("distance to empty string equals length", () => {
    for (const s of SAMPLES) {
      expect(levenshtein(s, "")).toBe(s.length);
      expect(levenshtein("", s)).toBe(s.length);
    }
  });

  test("known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("Novák", "Nowak")).toBe(2);
  });

  test("symmetry: d(a,b) === d(b,a)", () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
      }
    }
  });

  test("triangle inequality: d(a,c) <= d(a,b) + d(b,c)", () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        for (const c of SAMPLES) {
          expect(levenshtein(a, c)).toBeLessThanOrEqual(
            levenshtein(a, b) + levenshtein(b, c),
          );
        }
      }
    }
  });
});
