import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["passport number"],
  workspaceId: "passport-keywords-test",
};

const detect = (
  language: string,
  fullText: string,
): Promise<NativePipelineEntity[]> =>
  detectNative({ ...BASE_CONFIG, languages: [language] }, fullText);

describe("localized passport-number triggers", () => {
  test.each([
    ["cs", "cestovní pas AB123456", "AB123456"],
    ["cs", "cestovní pas č. AB123456", "AB123456"],
    ["de", "Reisepass C01X00T47", "C01X00T47"],
    ["de", "Reisepass Nr. C01X00T47", "C01X00T47"],
    ["de", "Reisepass 123456789", "123456789"],
    ["fr", "passeport AB1234567", "AB1234567"],
    ["fr", "passeport n° AB1234567", "AB1234567"],
  ] as const)(
    "%s detects the localized passport value",
    async (language, text, expected) => {
      const entities = await detect(language, text);

      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "passport number",
            text: expected,
          }),
        ]),
      );
    },
  );

  test.each([
    ["cs", "cestovní pas AB12345"],
    ["de", "Reisepass 123456"],
    ["fr", "passeport ABC123456"],
  ] as const)(
    "%s rejects an invalid passport shape",
    async (language, text) => {
      const entities = await detect(language, text);

      expect(entities).toEqual([]);
    },
  );
});
