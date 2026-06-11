import { describe, expect, test } from "bun:test";

import { diffDocuments } from "../diff";
import type { RunDocument, RunEntity } from "../types";
import { spanKey } from "../verdicts";

const entity = (
  start: number,
  end: number,
  label: string,
  text: string,
): RunEntity => ({ start, end, label, text, score: 0.9, source: "regex" });

const doc = (entities: RunEntity[]): RunDocument => ({
  docId: "acc-1:ex10.htm",
  sha256: "abc123",
  language: "en",
  entityCount: entities.length,
  entities,
});

const jane = entity(0, 8, "person", "Jane Doe");
const acme = entity(20, 29, "organization", "Acme Corp");
const date = entity(40, 50, "date", "2024-01-01");

describe("diffDocuments", () => {
  test("without baseline, every span is a candidate", () => {
    const diff = diffDocuments({
      current: doc([jane, acme]),
      baseline: null,
      judged: new Set(),
    });
    expect(diff.added).toEqual([jane, acme]);
    expect(diff.removed).toEqual([]);
  });

  test("with baseline, reports only added and removed spans", () => {
    const diff = diffDocuments({
      current: doc([jane, date]),
      baseline: doc([jane, acme]),
      judged: new Set(),
    });
    expect(diff.added).toEqual([date]);
    expect(diff.removed).toEqual([acme]);
  });

  test("judged spans never resurface on either side", () => {
    const diff = diffDocuments({
      current: doc([jane, date]),
      baseline: doc([jane, acme]),
      judged: new Set([spanKey(date), spanKey(acme)]),
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("same offsets with a different label are distinct spans", () => {
    const relabeled = { ...jane, label: "organization" };
    const diff = diffDocuments({
      current: doc([relabeled]),
      baseline: doc([jane]),
      judged: new Set(),
    });
    expect(diff.added).toEqual([relabeled]);
    expect(diff.removed).toEqual([jane]);
  });
});
