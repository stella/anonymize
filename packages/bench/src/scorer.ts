import type { BenchSpan } from "./types";

/**
 * exact: a prediction counts only when label, start, and end all match.
 * overlap: a prediction counts when the label matches and the spans
 * share at least one character; for anonymization a partial hit still
 * redacts part of the value, but exact mode is the honest headline.
 */
export type MatchMode = "exact" | "overlap";

export type LabelCounts = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
};

export type LabelMetrics = LabelCounts & {
  goldCount: number;
  precision: number;
  recall: number;
  f1: number;
};

type ScoreDocumentOptions = {
  gold: BenchSpan[];
  predicted: BenchSpan[];
  mode: MatchMode;
  /** Restrict scoring to these labels; both sides are filtered. */
  labels?: readonly string[] | undefined;
};

const overlapLength = (a: BenchSpan, b: BenchSpan): number =>
  Math.min(a.end, b.end) - Math.max(a.start, b.start);

const groupByLabel = (spans: BenchSpan[]): Map<string, BenchSpan[]> => {
  const groups = new Map<string, BenchSpan[]>();
  for (const span of spans) {
    const group = groups.get(span.label);
    if (group) {
      group.push(span);
    } else {
      groups.set(span.label, [span]);
    }
  }
  return groups;
};

/**
 * One-to-one matching within a label: gold spans are visited in
 * document order; each claims the unmatched prediction with the
 * largest overlap (exact mode requires identical bounds).
 */
const countLabelMatches = (
  gold: BenchSpan[],
  predicted: BenchSpan[],
  mode: MatchMode,
): number => {
  const used = predicted.map(() => false);
  let truePositives = 0;
  const sortedGold = gold.toSorted((a, b) => a.start - b.start);
  for (const goldSpan of sortedGold) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (const [index, prediction] of predicted.entries()) {
      if (used[index]) continue;
      if (mode === "exact") {
        if (
          prediction.start === goldSpan.start &&
          prediction.end === goldSpan.end
        ) {
          bestIndex = index;
          break;
        }
        continue;
      }
      const overlap = overlapLength(goldSpan, prediction);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) continue;
    used[bestIndex] = true;
    truePositives += 1;
  }
  return truePositives;
};

/** Per-label true/false positive and false negative counts for one document. */
export const scoreDocument = ({
  gold,
  predicted,
  mode,
  labels,
}: ScoreDocumentOptions): Map<string, LabelCounts> => {
  const labelFilter = labels ? new Set(labels) : null;
  const keep = (span: BenchSpan) =>
    labelFilter === null || labelFilter.has(span.label);
  const goldGroups = groupByLabel(gold.filter(keep));
  const predictedGroups = groupByLabel(predicted.filter(keep));

  const counts = new Map<string, LabelCounts>();
  const allLabels = new Set([...goldGroups.keys(), ...predictedGroups.keys()]);
  for (const label of allLabels) {
    const goldSpans = goldGroups.get(label) ?? [];
    const predictedSpans = predictedGroups.get(label) ?? [];
    const truePositives = countLabelMatches(goldSpans, predictedSpans, mode);
    counts.set(label, {
      truePositives,
      falsePositives: predictedSpans.length - truePositives,
      falseNegatives: goldSpans.length - truePositives,
    });
  }
  return counts;
};

export const mergeCounts = (
  into: Map<string, LabelCounts>,
  from: Map<string, LabelCounts>,
): void => {
  for (const [label, counts] of from) {
    const existing = into.get(label);
    if (!existing) {
      into.set(label, { ...counts });
      continue;
    }
    existing.truePositives += counts.truePositives;
    existing.falsePositives += counts.falsePositives;
    existing.falseNegatives += counts.falseNegatives;
  }
};

export const toMetrics = ({
  truePositives,
  falsePositives,
  falseNegatives,
}: LabelCounts): LabelMetrics => {
  const predictedCount = truePositives + falsePositives;
  const goldCount = truePositives + falseNegatives;
  const precision = predictedCount === 0 ? 0 : truePositives / predictedCount;
  const recall = goldCount === 0 ? 0 : truePositives / goldCount;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    goldCount,
    precision,
    recall,
    f1,
  };
};

export const microCounts = (counts: Map<string, LabelCounts>): LabelCounts => {
  const total: LabelCounts = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };
  for (const labelCounts of counts.values()) {
    total.truePositives += labelCounts.truePositives;
    total.falsePositives += labelCounts.falsePositives;
    total.falseNegatives += labelCounts.falseNegatives;
  }
  return total;
};
