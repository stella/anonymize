import type { NativePrediction } from "../adapters/types";

export type SpanGoldDocument = {
  readonly id: string;
  readonly text: string;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
};

export type SpanScore = {
  readonly spanRecall: number;
  readonly characterRecall: number;
  readonly characterPrecision: number;
  readonly goldSpans: number;
};

export const scoreSpanCorpus = (
  documents: readonly SpanGoldDocument[],
  predictions: ReadonlyMap<string, readonly NativePrediction[]>,
): SpanScore => {
  let coveredSpans = 0;
  let goldSpans = 0;
  let requiredCharacters = 0;
  let coveredRequiredCharacters = 0;
  let predictedCharacters = 0;
  let acceptedPredictedCharacters = 0;

  for (const document of documents) {
    const predicted = predictions.get(document.id) ?? [];
    const required = new Uint8Array(document.text.length);
    const masked = new Uint8Array(document.text.length);
    for (const span of document.spans) {
      goldSpans += 1;
      if (
        predicted.some(
          ({ start, end }) => start <= span.start && end >= span.end,
        )
      ) {
        coveredSpans += 1;
      }
      for (let offset = span.start; offset < span.end; offset += 1) {
        if (!/\s/u.test(document.text[offset] ?? "")) required[offset] = 1;
      }
    }
    for (const prediction of predicted) {
      const start = Math.max(0, prediction.start);
      const end = Math.min(document.text.length, prediction.end);
      for (let offset = start; offset < end; offset += 1) {
        if (!/\s/u.test(document.text[offset] ?? "")) masked[offset] = 1;
      }
    }
    for (let offset = 0; offset < document.text.length; offset += 1) {
      requiredCharacters += required[offset] ?? 0;
      predictedCharacters += masked[offset] ?? 0;
      if (required[offset] === 1 && masked[offset] === 1) {
        coveredRequiredCharacters += 1;
        acceptedPredictedCharacters += 1;
      }
    }
  }

  return {
    spanRecall: goldSpans === 0 ? 1 : coveredSpans / goldSpans,
    characterRecall:
      requiredCharacters === 0
        ? 1
        : coveredRequiredCharacters / requiredCharacters,
    characterPrecision:
      predictedCharacters === 0
        ? 0
        : acceptedPredictedCharacters / predictedCharacters,
    goldSpans,
  };
};
