import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const CONFIG: PipelineConfig = {
  threshold: 0.8,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["case number"],
  workspaceId: "case-number-formats-test",
};

const detectCaseNumbers = async (
  text: string,
): Promise<NativePipelineEntity[]> =>
  (await detectNative(CONFIG, text)).filter(
    (entity) => entity.label === "case number",
  );

describe("case number formats", () => {
  test.each([
    ["ECLI", "ECLI:EU:C:2024:123", "ECLI:EU:C:2024:123"],
    [
      "extended ECLI",
      "ECLI:CZ:NS:2024:8.Tdo.1234.2024.1",
      "ECLI:CZ:NS:2024:8.Tdo.1234.2024.1",
    ],
    ["UK Supreme Court", "[2024] UKSC 1", "[2024] UKSC 1"],
    ["UK Court of Appeal", "[2023] EWCA Civ 123", "[2023] EWCA Civ 123"],
    ["US federal docket", "1:23-cv-04567", "1:23-cv-04567"],
    ["US criminal docket", "12:22-cr-0001", "12:22-cr-0001"],
    ["German Aktenzeichen", "Az. 1 BvR 123/24", "1 BvR 123/24"],
    ["German full keyword", "Aktenzeichen 12 O 456/2023", "12 O 456/2023"],
    ["Polish sygnatura akt", "sygn. akt III CZP 10/23", "III CZP 10/23"],
    ["Polish short keyword", "sygn. I ACa 1234/22", "I ACa 1234/22"],
  ] as const)("%s is detected", async (_jurisdiction, text, expected) => {
    expect(await detectCaseNumbers(text)).toEqual([
      expect.objectContaining({ text: expected }),
    ]);
  });

  test.each([
    ["ECLI prefix without an identifier", "ECLI: something"],
    ["bracketed year without a court code", "[2024] report 1"],
    ["uppercase US prose-like sequence", "Version 1:23-AB-04567"],
    ["ungated German case shape", "Citation 1 BvR 123/24"],
    ["invalid German value after the keyword", "Az. Kapitel 1"],
    ["ungated Polish case shape", "Citation III CZP 10/23"],
    ["invalid Polish value after the keyword", "sygn. akt dokument"],
  ] as const)("%s is rejected", async (_description, text) => {
    expect(await detectCaseNumbers(text)).toEqual([]);
  });
});
