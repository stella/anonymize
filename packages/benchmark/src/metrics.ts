import type { GroundTruthDocument } from "./ground-truth";
import type { NativePrediction } from "./adapters/types";
import {
  type CommonLabel,
  isCommonLabel,
  type NativeMapping,
} from "./taxonomy";

/** Span in the common taxonomy, after mapping a library's native output. */
type CommonSpan = {
  readonly start: number;
  readonly end: number;
  readonly label: CommonLabel;
};

/**
 * Span matching mode.
 *   - overlap: same label and IoU (intersection / union of character ranges)
 *     >= 0.5. This is the primary rule: it credits near-miss boundaries
 *     (e.g. a title included or a trailing period) that are still correct
 *     detections in practice.
 *   - exact: same label and identical [start, end). Secondary, stricter rule.
 */
export const MATCH_MODES = ["overlap", "exact"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const OVERLAP_THRESHOLD = 0.5;

const iou = (a: CommonSpan, b: CommonSpan): number => {
  const interStart = Math.max(a.start, b.start);
  const interEnd = Math.min(a.end, b.end);
  const inter = Math.max(0, interEnd - interStart);
  if (inter === 0) {
    return 0;
  }
  const union = a.end - a.start + (b.end - b.start) - inter;
  return inter / union;
};

const matches = (
  pred: CommonSpan,
  gold: CommonSpan,
  mode: MatchMode,
): boolean => {
  if (pred.label !== gold.label) {
    return false;
  }
  return mode === "exact"
    ? pred.start === gold.start && pred.end === gold.end
    : iou(pred, gold) >= OVERLAP_THRESHOLD;
};

export const mapPredictions = (
  predictions: readonly NativePrediction[],
  mapping: NativeMapping,
): CommonSpan[] => {
  const mapped: CommonSpan[] = [];
  for (const { start, end, label } of predictions) {
    if (!Object.hasOwn(mapping, label)) {
      // Unknown native label: keep it if it is already a common label, else
      // drop. Dropping avoids charging a library for labels we never mapped.
      if (isCommonLabel(label)) {
        mapped.push({ start, end, label });
      }
      continue;
    }
    const common = mapping[label];
    if (common !== null && common !== undefined) {
      mapped.push({ start, end, label: common });
    }
  }
  return mapped;
};

export const OUTCOME_KINDS = ["tp", "fp", "fn"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** One scored span: a matched pair (tp), an unmatched prediction (fp), or an
 * unmatched gold entity (fn). Flat records aggregate flexibly by label/language. */
export type ScoredSpan = {
  readonly docId: string;
  readonly language: string;
  readonly label: CommonLabel;
  readonly kind: OutcomeKind;
};

const scoreDocument = (
  doc: GroundTruthDocument,
  preds: readonly CommonSpan[],
  mode: MatchMode,
): ScoredSpan[] => {
  const golds = doc.entities;
  type Pair = { pi: number; gi: number; score: number };
  const pairs: Pair[] = [];
  for (let pi = 0; pi < preds.length; pi++) {
    for (let gi = 0; gi < golds.length; gi++) {
      // SAFETY: pi/gi are in range by loop bounds.
      const pred = preds[pi] as CommonSpan;
      const gold = golds[gi] as (typeof golds)[number];
      if (matches(pred, gold, mode)) {
        pairs.push({ pi, gi, score: mode === "exact" ? 1 : iou(pred, gold) });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedPred = new Set<number>();
  const usedGold = new Set<number>();
  const scored: ScoredSpan[] = [];
  for (const { pi, gi } of pairs) {
    if (usedPred.has(pi) || usedGold.has(gi)) {
      continue;
    }
    usedPred.add(pi);
    usedGold.add(gi);
    // SAFETY: pi in range.
    scored.push({
      docId: doc.id,
      language: doc.language,
      label: (preds[pi] as CommonSpan).label,
      kind: "tp",
    });
  }
  for (let pi = 0; pi < preds.length; pi++) {
    if (!usedPred.has(pi)) {
      scored.push({
        docId: doc.id,
        language: doc.language,
        label: (preds[pi] as CommonSpan).label,
        kind: "fp",
      });
    }
  }
  for (let gi = 0; gi < golds.length; gi++) {
    if (!usedGold.has(gi)) {
      scored.push({
        docId: doc.id,
        language: doc.language,
        label: (golds[gi] as (typeof golds)[number]).label,
        kind: "fn",
      });
    }
  }
  return scored;
};

/** Score an entire corpus for one adapter and one match mode. */
export const scoreCorpus = (
  docs: readonly GroundTruthDocument[],
  predictionsByDoc: ReadonlyMap<string, readonly NativePrediction[]>,
  mapping: NativeMapping,
  mode: MatchMode,
): ScoredSpan[] => {
  const scored: ScoredSpan[] = [];
  for (const doc of docs) {
    const preds = mapPredictions(predictionsByDoc.get(doc.id) ?? [], mapping);
    scored.push(...scoreDocument(doc, preds, mode));
  }
  return scored;
};

export type Prf = {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
};

export const aggregate = (spans: readonly ScoredSpan[]): Prf => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const span of spans) {
    if (span.kind === "tp") {
      tp++;
    } else if (span.kind === "fp") {
      fp++;
    } else {
      fn++;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
};
