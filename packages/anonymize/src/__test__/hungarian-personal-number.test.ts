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
  labels: ["national identification number"],
  workspaceId: "hungarian-personal-number-test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(TRIGGERS_ONLY_CONFIG, fullText);

describe("Hungarian personal-number trigger", () => {
  test.each(["1-850101-1234", "18501011234"])(
    "detects personal-number value %s",
    async (value) => {
      const entities = await detect(`személyi szám: ${value}`);

      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "national identification number",
            text: value,
          }),
        ]),
      );
    },
  );

  test("stops before trailing punctuation", async () => {
    const entities = await detect("személyi szám: 1-850101-1234, lakcím");

    expect(entities).toEqual([
      expect.objectContaining({
        label: "national identification number",
        text: "1-850101-1234",
      }),
    ]);
  });

  test.each(["123456AB", "1-850101-123", "1850101123"])(
    "rejects invalid value %s",
    async (value) => {
      const entities = await detect(`személyi szám: ${value}`);

      expect(entities).toEqual([]);
    },
  );
});
