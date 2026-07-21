import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const TRIGGERS_ONLY_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["bank account number"],
  workspaceId: "swift-bic-trigger-test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(TRIGGERS_ONLY_CONFIG, fullText);

describe("SWIFT/BIC triggers", () => {
  test.each([
    ["BIC code GIBACZPX", "GIBACZPX"],
    ["SWIFT code DEUTDEFF", "DEUTDEFF"],
    ["BIC: GIBACZPX", "GIBACZPX"],
    ["SWIFT: DEUTDEFF", "DEUTDEFF"],
  ] as const)("%s captures the code value", async (text, expected) => {
    const entities = await detect(text);

    expect(entities).toEqual([
      expect.objectContaining({
        label: "bank account number",
        text: expected,
      }),
    ]);
  });
});
