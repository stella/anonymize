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
  labels: ["registration number"],
  workspaceId: "czech-reference-number-test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(TRIGGERS_ONLY_CONFIG, fullText);

describe("Czech reference-number triggers", () => {
  test.each([
    ["sp. zn.", "sp. zn. C 75209", "C 75209"],
    ["č. j.", "č. j. SPU 123456/2024", "SPU 123456/2024"],
    [
      "číslo jednací",
      "číslo jednací ČKPP-54890/2022-210",
      "ČKPP-54890/2022-210",
    ],
    ["číslo smlouvy", "číslo smlouvy 2024/S/507/0031", "2024/S/507/0031"],
  ] as const)(
    "%s captures the following reference",
    async (_name, text, expected) => {
      const entities = await detect(text);

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

  test("stops at the identifier boundary", async () => {
    const entities = await detect("č. j. 123/2024 ze dne 1. ledna 2024");

    expect(entities.map(({ text }) => text)).toEqual(["123/2024"]);
  });

  test.each([
    "číslo Smlouvy rámcové vymezení",
    "číslo Smlouvy a Dílčí smlouvy (Objednávky)",
  ])(
    "does not treat prose after a list label as a reference: %s",
    async (text) => {
      expect(await detect(text)).toEqual([]);
    },
  );
});
