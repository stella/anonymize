import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { PipelineConfig } from "../types";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "contract-quality-test",
};

const detect = async (text: string) =>
  runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: createPipelineContext(),
  });

describe("contract quality regressions", () => {
  test("rejects sentence fragments chained into person names", async () => {
    const entities = await detect(
      "(e)Employee Benefits. In addition to the compensation discussed above.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text.includes("Benefits. In"),
      ),
    ).toBe(false);
  });

  test("rejects signing-clause pseudo-addresses", async () => {
    const entities = await detect("V Brně dne 1. 1. 2026");

    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "V Brně dne",
      ),
    ).toBe(false);
  });

  test("rejects single-letter court section markers as registration numbers", async () => {
    const entities = await detect(
      "zapsaná v OR vedeném u Krajského soudu v Brně, oddíl C, vložka 30549",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "registration number" && entity.text === "C",
      ),
    ).toBe(false);
  });
});
