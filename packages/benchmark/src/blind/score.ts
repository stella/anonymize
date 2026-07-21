import type { NativePrediction } from "../adapters/types";
import type { TabDocument } from "./tab";

type Span = { readonly start: number; readonly end: number };

export type BlindScore = {
  readonly documents: number;
  readonly directMentions: number;
  readonly quasiMentions: number;
  readonly directMentionRecall: number;
  readonly quasiMentionRecall: number;
  readonly allMentionRecall: number;
  readonly entityRecall: number;
  readonly characterPrecision: number;
  readonly characterRecall: number;
  readonly predictedSpans: number;
};

const mergeSpans = (spans: readonly Span[], textLength: number): Span[] => {
  const valid = spans
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
  for (const span of valid) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) {
      merged.push({ ...span });
    } else {
      previous.end = Math.max(previous.end, span.end);
    }
  }
  return merged;
};

const fullyCovered = (span: Span, masks: readonly Span[]): boolean =>
  masks.some(({ start, end }) => start <= span.start && end >= span.end);

const maskedCharacters = (
  text: string,
  spans: readonly Span[],
): Set<number> => {
  const offsets = new Set<number>();
  for (const { start, end } of spans) {
    for (let offset = start; offset < end; offset++) {
      if (!/\s/u.test(text[offset] ?? "")) {
        offsets.add(offset);
      }
    }
  }
  return offsets;
};

const recall = (covered: number, total: number): number =>
  total === 0 ? 0 : covered / total;

export const scoreBlindCorpus = (
  documents: readonly TabDocument[],
  predictionsByDocument: ReadonlyMap<string, readonly NativePrediction[]>,
): BlindScore => {
  let directMentions = 0;
  let quasiMentions = 0;
  let coveredDirectMentions = 0;
  let coveredQuasiMentions = 0;
  let coveredEntities = 0;
  let entities = 0;
  let predictedSpans = 0;
  let predictedCharacters = 0;
  let goldCharacters = 0;
  let overlappingCharacters = 0;

  for (const document of documents) {
    const rawPredictions = predictionsByDocument.get(document.id) ?? [];
    predictedSpans += rawPredictions.length;
    const masks = mergeSpans(rawPredictions, document.text.length);
    const predictionOffsets = maskedCharacters(document.text, masks);

    for (const annotation of document.annotations) {
      const goldMentions = annotation.mentions.filter(
        ({ identifierType }) => identifierType !== "NO_MASK",
      );
      const goldMasks = mergeSpans(goldMentions, document.text.length);

      for (const mention of goldMentions) {
        const covered = fullyCovered(mention, masks);
        if (mention.identifierType === "DIRECT") {
          directMentions++;
          if (covered) {
            coveredDirectMentions++;
          }
        } else {
          quasiMentions++;
          if (covered) {
            coveredQuasiMentions++;
          }
        }
      }

      const mentionsByEntity = new Map<string, Span[]>();
      for (const mention of goldMentions) {
        const mentions = mentionsByEntity.get(mention.entityId) ?? [];
        mentions.push(mention);
        mentionsByEntity.set(mention.entityId, mentions);
      }
      for (const mentions of mentionsByEntity.values()) {
        entities++;
        if (mentions.every((mention) => fullyCovered(mention, masks))) {
          coveredEntities++;
        }
      }

      const goldOffsets = maskedCharacters(document.text, goldMasks);
      predictedCharacters += predictionOffsets.size;
      goldCharacters += goldOffsets.size;
      for (const offset of predictionOffsets) {
        if (goldOffsets.has(offset)) {
          overlappingCharacters++;
        }
      }
    }
  }

  return {
    documents: documents.length,
    directMentions,
    quasiMentions,
    directMentionRecall: recall(coveredDirectMentions, directMentions),
    quasiMentionRecall: recall(coveredQuasiMentions, quasiMentions),
    allMentionRecall: recall(
      coveredDirectMentions + coveredQuasiMentions,
      directMentions + quasiMentions,
    ),
    entityRecall: recall(coveredEntities, entities),
    characterPrecision: recall(overlappingCharacters, predictedCharacters),
    characterRecall: recall(overlappingCharacters, goldCharacters),
    predictedSpans,
  };
};
