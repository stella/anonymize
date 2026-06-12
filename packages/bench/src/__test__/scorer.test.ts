import { describe, expect, test } from "bun:test";

import {
  type LabelCounts,
  mergeCounts,
  microCounts,
  scoreDocument,
  toMetrics,
} from "../scorer";
import type { BenchSpan } from "../types";

const span = (start: number, end: number, label: string): BenchSpan => ({
  start,
  end,
  label,
});

const counts = (
  result: Map<string, LabelCounts>,
  label: string,
): LabelCounts => {
  const labelCounts = result.get(label);
  if (!labelCounts) throw new Error(`no counts for label ${label}`);
  return labelCounts;
};

describe("scoreDocument", () => {
  test("exact mode requires identical bounds", () => {
    const gold = [span(0, 10, "person")];
    const shifted = [span(1, 10, "person")];
    const exact = scoreDocument({ gold, predicted: shifted, mode: "exact" });
    expect(counts(exact, "person")).toEqual({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
    });
    const overlap = scoreDocument({
      gold,
      predicted: shifted,
      mode: "overlap",
    });
    expect(counts(overlap, "person")).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });
  });

  test("label mismatch never matches even with identical bounds", () => {
    const result = scoreDocument({
      gold: [span(0, 5, "person")],
      predicted: [span(0, 5, "organization")],
      mode: "overlap",
    });
    expect(counts(result, "person").falseNegatives).toBe(1);
    expect(counts(result, "organization").falsePositives).toBe(1);
  });

  test("adjacent spans do not overlap (end is exclusive)", () => {
    const result = scoreDocument({
      gold: [span(0, 5, "person")],
      predicted: [span(5, 9, "person")],
      mode: "overlap",
    });
    expect(counts(result, "person").truePositives).toBe(0);
  });

  test("one gold span absorbs at most one of several predictions", () => {
    const result = scoreDocument({
      gold: [span(0, 10, "person")],
      predicted: [span(0, 4, "person"), span(2, 10, "person")],
      mode: "overlap",
    });
    expect(counts(result, "person")).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
    });
  });

  test("largest overlap wins when several predictions compete", () => {
    const gold = [span(0, 10, "person"), span(20, 30, "person")];
    const predicted = [span(8, 25, "person"), span(0, 9, "person")];
    const result = scoreDocument({ gold, predicted, mode: "overlap" });
    // First gold takes the 9-char overlap (0..9); second takes 8..25.
    expect(counts(result, "person")).toEqual({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
    });
  });

  test("labels filter drops both gold and predictions", () => {
    const result = scoreDocument({
      gold: [span(0, 5, "person"), span(10, 15, "date")],
      predicted: [span(10, 15, "date"), span(20, 25, "organization")],
      mode: "exact",
      labels: ["date"],
    });
    expect([...result.keys()]).toEqual(["date"]);
    expect(counts(result, "date").truePositives).toBe(1);
  });
});

describe("aggregation", () => {
  test("mergeCounts accumulates and microCounts sums labels", () => {
    const into = scoreDocument({
      gold: [span(0, 5, "person")],
      predicted: [span(0, 5, "person")],
      mode: "exact",
    });
    const from = scoreDocument({
      gold: [span(0, 5, "person"), span(8, 12, "date")],
      predicted: [span(1, 5, "person")],
      mode: "exact",
    });
    mergeCounts(into, from);
    expect(counts(into, "person")).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
    });
    expect(microCounts(into)).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 2,
    });
  });

  test("toMetrics handles empty sides without dividing by zero", () => {
    expect(
      toMetrics({ truePositives: 0, falsePositives: 0, falseNegatives: 0 }),
    ).toMatchObject({ precision: 0, recall: 0, f1: 0 });
    const metrics = toMetrics({
      truePositives: 3,
      falsePositives: 1,
      falseNegatives: 1,
    });
    expect(metrics.precision).toBeCloseTo(0.75);
    expect(metrics.recall).toBeCloseTo(0.75);
    expect(metrics.f1).toBeCloseTo(0.75);
    expect(metrics.goldCount).toBe(4);
  });
});
