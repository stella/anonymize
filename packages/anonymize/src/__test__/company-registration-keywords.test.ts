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
  labels: ["registration number"],
  workspaceId: "company-registration-keywords-test",
};

const detect = (
  language: string,
  fullText: string,
): Promise<NativePipelineEntity[]> =>
  detectNative({ ...BASE_CONFIG, languages: [language] }, fullText);

describe("company registration-number keywords", () => {
  test.each([
    ["de", "eingetragen beim Amtsgericht, HRA 6789", "6789"],
    ["de", "HRB 1234", "1234"],
    ["en", "KvK: 12345678", "12345678"],
    ["en", "Kamer van Koophandel 87654321", "87654321"],
    ["en", "registered number NI654321", "NI654321"],
    ["fr", "RCS Paris 123456789", "123456789"],
    ["fr", "RCS Luxembourg B 123456", "B 123456"],
    ["fr", "RCS B 123456", "B 123456"],
  ] as const)(
    "%s trigger in %s detects the registration number",
    async (language, text, expected) => {
      const entities = await detect(language, text);

      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "registration number",
            text: expected,
          }),
        ]),
      );
    },
  );
});
