import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  runPipeline,
} from "../index";
import type { PipelineConfig } from "../types";

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [],
  workspaceId: "test",
};

const detect = async (
  fullText: string,
  config: Partial<PipelineConfig>,
) =>
  runPipeline({
    fullText,
    config: {
      ...BASE_CONFIG,
      ...config,
    },
    gazetteerEntries: [],
    context: createPipelineContext(),
  });

describe("pipeline config semantics", () => {
  test("labels filter applies to deterministic detectors", async () => {
    const entities = await detect(
      "Datum narození: 2024-01-02",
      {
        enableRegex: true,
        labels: ["person"],
      },
    );
    expect(entities).toHaveLength(0);
  });

  test("enableLegalForms disables legal-form detection", async () => {
    const entities = await detect(
      "Acme s.r.o.",
      {
        enableLegalForms: false,
        labels: ["organization"],
      },
    );
    expect(entities).toHaveLength(0);
  });

  test("enableNameCorpus disables name matches in deny-list mode", async () => {
    const entities = await detect(
      "Jan Novak",
      {
        enableDenyList: true,
        enableNameCorpus: false,
        denyListCountries: ["CZ"],
        labels: ["person"],
      },
    );
    expect(entities).toHaveLength(0);
  });

  test("enableNameCorpus keeps name matches available in deny-list mode", async () => {
    const entities = await detect(
      "Jan Novak",
      {
        enableDenyList: true,
        enableNameCorpus: true,
        denyListCountries: ["CZ"],
        labels: ["person"],
      },
    );
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          entity.text === "Jan Novak",
      ),
    ).toBe(true);
  });
});
