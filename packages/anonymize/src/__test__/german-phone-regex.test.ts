import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const CONFIG: PipelineConfig = {
  threshold: 0.8,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["phone number"],
  workspaceId: "german-phone-regex-test",
};

const detectPhones = async (text: string): Promise<NativePipelineEntity[]> =>
  (await detectNative(CONFIG, text)).filter(
    (entity) => entity.label === "phone number",
  );

describe("German phone regex formats", () => {
  test.each([
    ["030 12345678", "030 12345678"],
    ["Berlin landline: 030/1234567", "030/1234567"],
    ["German number: +49(0)151-12345678", "+49(0)151-12345678"],
  ] as const)("detects %s", async (text, expected) => {
    expect(await detectPhones(text)).toEqual([
      expect.objectContaining({ text: expected }),
    ]);
  });

  test("does not treat a short zero-prefixed reference as a phone", async () => {
    expect(await detectPhones("Reference 030 1234")).toEqual([]);
  });
});
