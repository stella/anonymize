import { describe, expect, test } from "bun:test";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
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
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["address"],
  workspaceId: "addr-noise-test",
  dictionaries,
};

const addresses = async (text: string): Promise<NativePipelineEntity[]> => {
  const entities = await detectNative(config, text);
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
