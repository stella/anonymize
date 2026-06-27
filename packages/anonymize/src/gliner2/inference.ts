import type { NerInferenceFn } from "../pipeline";
import type { Entity } from "../types";
import { Gliner2Client, type Gliner2ClientOptions } from "./client";
import { expandLabels, collapseLabel } from "./label-map";
import { DETECTION_SOURCES } from "../constants";

export const buildGliner2Inference = (
  options: Gliner2ClientOptions = {},
): NerInferenceFn => {
  const client = new Gliner2Client(options);

  return async (fullText, labels, threshold, signal): Promise<Entity[]> => {
    const modelLabels = expandLabels(labels);
    if (modelLabels.length === 0) return [];

    const pipelineLabelSet = new Set(labels);
    const response = await client.infer(
      fullText,
      modelLabels,
      threshold,
      signal,
    );

    return response.entities.map(
      (e): Entity => ({
        text: e.text,
        start: e.start,
        end: e.end,
        label: collapseLabel(e.label, pipelineLabelSet),
        score: e.score,
        source: DETECTION_SOURCES.NER,
      }),
    );
  };
};
