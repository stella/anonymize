import { describe, expect, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const config = (language: string): PipelineConfig => ({
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: ["social security number"],
  language,
  workspaceId: `us-ssn-trigger-${language}`,
});

const socialSecurityNumbers = async (
  text: string,
  language = "en",
): Promise<NativePipelineEntity[]> =>
  (await detectNative(config(language), text)).filter(
    ({ label }) => label === "social security number",
  );

describe("English U.S. Social Security number triggers", () => {
  // SSA identifies 219-09-9999 as a made-up Social Security Board specimen:
  // https://www.ssa.gov/policy/docs/ssb/v69n2/v69n2p55.html
  test.each([
    ["Social Security Number 219-09-9999", "219-09-9999"],
    ["Social Security No.: 219 09 9999", "219 09 9999"],
    ["Social Security No 219-09-9999", "219-09-9999"],
    ["Social Security Number #219-09-9999", "219-09-9999"],
    ["SSN# 219-09-9999", "219-09-9999"],
    ["SSN # 219-09-9999", "219-09-9999"],
    ["Employee SSN=219-09-9999", "219-09-9999"],
    ["SSN 219099999", "219099999"],
  ] as const)("%s captures the grouped identifier", async (text, expected) => {
    expect(await socialSecurityNumbers(text)).toContainEqual(
      expect.objectContaining({ text: expected }),
    );
  });

  test.each([
    "SSN 000-12-3456",
    "SSN 666-12-3456",
    "SSN 900-12-3456",
    "SSN 123-00-3456",
    "SSN 123-45-0000",
  ])("rejects an SSA-impossible identifier %s", async (text) => {
    expect(await socialSecurityNumbers(text)).toEqual([]);
  });

  test.each(["SSN 123-45 6789", "SSN 123 45-6789", "SSN １２３-４５-６７８９"])(
    "rejects a mixed-separator or non-ASCII identifier %s",
    async (text) => {
      expect(await socialSecurityNumbers(text)).toEqual([]);
    },
  );

  test.each([
    "SSN 219-09-9999-1234",
    "SSN 219099999-1234",
    "SSN 219-09-9999-A",
    "SSN 219-09-9999/123",
    "SSN 219-09-9999.123",
    "SSN 219-09-9999+123",
    "SSN 219-09-9999‐123",
    "SSN 219-09-9999‑123",
    "SSN 219-09-9999‒123",
    "SSN 219-09-9999–123",
    "SSN 219-09-9999—123",
    "SSN 219-09-9999―123",
  ])("rejects an SSN-shaped prefix of a longer identifier %s", async (text) => {
    expect(await socialSecurityNumbers(text)).toEqual([]);
  });

  test("accepts a separate numeric field after the SSN", async () => {
    expect(
      await socialSecurityNumbers("SSN 219-09-9999 2024 tax return"),
    ).toContainEqual(expect.objectContaining({ text: "219-09-9999" }));
  });

  test("does not activate English vocabulary in another language scope", async () => {
    expect(
      await socialSecurityNumbers("Social Security Number 219-09-9999", "cs"),
    ).toEqual([]);
  });
});
