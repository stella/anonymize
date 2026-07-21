import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const CONFIG: PipelineConfig = {
  // Exclude the 0.9 regex entity so the 0.95 trigger path is required.
  threshold: 0.94,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["tax identification number"],
  workspaceId: "german-tax-id-test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(CONFIG, fullText);

describe("German tax identification number triggers", () => {
  test.each([
    ["Steuer-ID: 36574261809", "36574261809"],
    ["IdNr. 36574261809", "36574261809"],
    ["IdNr 36574261809", "36574261809"],
  ] as const)("%s detects the checksum-valid ID", async (text, expected) => {
    const entities = await detect(text);

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "tax identification number",
          text: expected,
        }),
      ]),
    );
  });
});
