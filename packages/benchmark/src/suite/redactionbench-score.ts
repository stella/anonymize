import type { NativePrediction } from "../adapters/types";
import type {
  RedactionBenchDocument,
  RedactionBenchSpan,
} from "./redactionbench";

type Span = { readonly start: number; readonly end: number };

export type RedactionBenchScore = {
  readonly documents: number;
  readonly mandatorySpans: number;
  readonly mandatorySpanRecall: number;
  readonly mandatoryCharacterRecall: number;
  readonly acceptedCharacterPrecision: number;
  readonly predictedSpans: number;
};

const mergeSpans = (spans: readonly Span[], textLength: number): Span[] => {
  const ordered = spans
    .filter(
      ({ start, end }) =>
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        end > start &&
        end <= textLength,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) {
      merged.push({ ...span });
    } else {
      previous.end = Math.max(previous.end, span.end);
    }
  }
  return merged;
};

const characters = (text: string, spans: readonly Span[]): Uint8Array => {
  const result = new Uint8Array(text.length);
  for (const { start, end } of spans) {
    for (let offset = start; offset < end; offset++) {
      if (!/\s/u.test(text[offset] ?? "")) {
        result[offset] = 1;
      }
    }
  }
  return result;
};

const ratio = (covered: number, total: number): number =>
  total === 0 ? 0 : covered / total;

const required = (spans: readonly RedactionBenchSpan[]): RedactionBenchSpan[] =>
  spans.filter(({ label }) => label === "mandatory");

export const scoreRedactionBench = (
  documents: readonly RedactionBenchDocument[],
  predictions: ReadonlyMap<string, readonly NativePrediction[]>,
): RedactionBenchScore => {
  let mandatorySpans = 0;
  let coveredMandatorySpans = 0;
  let mandatoryCharacters = 0;
  let coveredMandatoryCharacters = 0;
  let predictedCharacters = 0;
  let acceptedPredictedCharacters = 0;
  let predictedSpans = 0;

  for (const document of documents) {
    const rawPredictions = predictions.get(document.id) ?? [];
    predictedSpans += rawPredictions.length;
    const masks = mergeSpans(rawPredictions, document.text.length);
    const mandatory = required(document.spans);
    mandatorySpans += mandatory.length;
    coveredMandatorySpans += mandatory.filter((span) =>
      masks.some(({ start, end }) => start <= span.start && end >= span.end),
    ).length;

    const predicted = characters(document.text, masks);
    const requiredCharacters = characters(document.text, mandatory);
    const acceptedCharacters = characters(document.text, document.spans);
    for (let offset = 0; offset < document.text.length; offset++) {
      if (requiredCharacters[offset] === 1) mandatoryCharacters++;
      if (predicted[offset] !== 1) continue;
      predictedCharacters++;
      if (requiredCharacters[offset] === 1) coveredMandatoryCharacters++;
      if (acceptedCharacters[offset] === 1) acceptedPredictedCharacters++;
    }
  }

  return {
    documents: documents.length,
    mandatorySpans,
    mandatorySpanRecall: ratio(coveredMandatorySpans, mandatorySpans),
    mandatoryCharacterRecall: ratio(
      coveredMandatoryCharacters,
      mandatoryCharacters,
    ),
    acceptedCharacterPrecision: ratio(
      acceptedPredictedCharacters,
      predictedCharacters,
    ),
    predictedSpans,
  };
};
