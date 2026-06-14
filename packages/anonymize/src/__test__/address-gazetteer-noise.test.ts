import { describe, expect, test } from "bun:test";
import { createPipelineContext, runPipeline } from "../index";
import type { Entity, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const config: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["address"],
  workspaceId: "addr-noise-test",
  dictionaries,
};

const addresses = async (text: string): Promise<Entity[]> => {
  const context = createPipelineContext();
  const entities = await runPipeline({
    fullText: text,
    config,
    gazetteerEntries: [],
    context,
  });
  return entities.filter((e) => e.label === "address");
};

describe("address gazetteer noise", () => {
  test("does not flag month words (August, March) as address", async () => {
    const found = await addresses("Rent is due in August and again in March.");
    expect(found.some((e) => e.text === "August" || e.text === "March")).toBe(
      false,
    );
  });

  test("still detects a real city as address", async () => {
    const found = await addresses("The tenant resides in Boston.");
    expect(found.some((e) => e.text === "Boston")).toBe(true);
  });
});
