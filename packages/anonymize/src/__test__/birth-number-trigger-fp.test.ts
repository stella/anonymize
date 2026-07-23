/**
 * Birth-number trigger values must contain digits. Motivated by Czech
 * "rodné číslo," capturing the next prose token; the guard is label-level.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

setDefaultTimeout(60_000);

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  enableHotwordRules: true,
  labels: ["birth number"],
  language: "cs",
  workspaceId: "birth-number-trigger-fp",
};

const birthNumbers = async (text: string): Promise<NativePipelineEntity[]> =>
  (await detectNative(CONFIG, text)).filter(
    ({ label }) => label === "birth number",
  );

describe("birth-number trigger false positives", () => {
  test("rejects prose after a birth-number cue", async () => {
    const text =
      "datum narození a rodné číslo,\núdaje o jejím zdravotním stavu apod.";

    expect(await birthNumbers(text)).toEqual([]);
  });

  test("keeps a digit birth number after the same cue", async () => {
    const entities = await birthNumbers("rodné číslo: 900101/1234");

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "birth number",
          text: "900101/1234",
        }),
      ]),
    );
  });

  test("does not treat an unrelated identifier cue as birth number", async () => {
    // Negative control: company-id trigger remains registration number.
    const entities = await detectNative(
      {
        ...CONFIG,
        labels: ["birth number", "registration number"],
      },
      "IČO: 70873046",
    );

    expect(entities.filter(({ label }) => label === "birth number")).toEqual(
      [],
    );
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "registration number",
          text: "70873046",
        }),
      ]),
    );
  });
});
