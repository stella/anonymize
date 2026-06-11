import { describe, expect, test } from "bun:test";

import { diffDocuments } from "../diff";
import type {
  RunDocument,
  RunEntity,
  SpanVerdict,
  VerdictSpan,
} from "../types";
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

const verdictSpan = (
  { start, end, label, text }: RunEntity,
  verdict: SpanVerdict,
): VerdictSpan => ({ start, end, value: text, label, verdict });

const judged = (
  pairs: [RunEntity, SpanVerdict][],
): ReadonlyMap<string, VerdictSpan> =>
  new Map(
    pairs.map(([span, verdict]) => [spanKey(span), verdictSpan(span, verdict)]),
  );

const jane = entity(0, 8, "person", "Jane Doe");
const acme = entity(20, 29, "organization", "Acme Corp");
const date = entity(40, 50, "date", "2024-01-01");

describe("diffDocuments", () => {
  test("without baseline, every unjudged span is an FP candidate", () => {
    const diff = diffDocuments({
      current: doc([jane, acme]),
      baseline: null,
      judged: judged([]),
    });
    expect(diff.added).toEqual([jane, acme]);
    expect(diff.removed).toEqual([]);
    expect(diff.regressions).toEqual([]);
    expect(diff.fixed).toEqual([]);
  });

  test("with baseline, reports added and removed unjudged spans", () => {
    const diff = diffDocuments({
      current: doc([jane, date]),
      baseline: doc([jane, acme]),
      judged: judged([]),
    });
    expect(diff.added).toEqual([date]);
    expect(diff.removed).toEqual([acme]);
    expect(diff.regressions).toEqual([]);
    expect(diff.fixed).toEqual([]);
  });

  test("a disappeared tp span surfaces as a regression, not removed", () => {
    const diff = diffDocuments({
      current: doc([jane]),
      baseline: doc([jane, acme]),
      judged: judged([[acme, "tp"]]),
    });
    expect(diff.removed).toEqual([]);
    expect(diff.regressions).toEqual([verdictSpan(acme, "tp")]);
  });

  test("a tp verdict missing from the run is a regression even without a baseline", () => {
    const diff = diffDocuments({
      current: doc([jane]),
      baseline: null,
      judged: judged([
        [jane, "tp"],
        [acme, "tp"],
      ]),
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.regressions).toEqual([verdictSpan(acme, "tp")]);
  });

  test("a disappeared fp span is expected and dropped from removed", () => {
    const diff = diffDocuments({
      current: doc([jane]),
      baseline: doc([jane, acme]),
      judged: judged([[acme, "fp"]]),
    });
    expect(diff.removed).toEqual([]);
    expect(diff.regressions).toEqual([]);
  });

  test("a newly detected fn span surfaces as fixed, not added", () => {
    const diff = diffDocuments({
      current: doc([jane, acme]),
      baseline: doc([jane]),
      judged: judged([[acme, "fn"]]),
    });
    expect(diff.added).toEqual([]);
    expect(diff.fixed).toEqual([acme]);
  });

  test("tp/fp judged new spans are not re-surfaced as FP candidates", () => {
    const diff = diffDocuments({
      current: doc([jane, acme, date]),
      baseline: doc([jane]),
      judged: judged([
        [acme, "tp"],
        [date, "fp"],
      ]),
    });
    expect(diff.added).toEqual([]);
    expect(diff.fixed).toEqual([]);
  });

  test("same offsets with a different label are distinct spans", () => {
    const relabeled = { ...jane, label: "organization" };
    const diff = diffDocuments({
      current: doc([relabeled]),
      baseline: doc([jane]),
      judged: judged([]),
    });
    expect(diff.added).toEqual([relabeled]);
    expect(diff.removed).toEqual([jane]);
  });
});
