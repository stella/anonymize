import { describe, expect, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "country-id-shapes-test",
};

const detect = async (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(CONFIG, fullText);

describe("country identifier regex shapes", () => {
  test("Swiss UID is detected as a company registration number", async () => {
    const entities = await detect("The company UID is CHE-101.374.515.");
    expect(entities).toContainEqual(
      expect.objectContaining({
        label: "registration number",
        text: "CHE-101.374.515",
      }),
    );
  });

  test("invalid Swiss UID checksum is rejected", async () => {
    const entities = await detect("The company UID is CHE-101.374.516.");
    expect(entities.some((entity) => entity.text.includes("CHE-"))).toBe(false);
  });

  test("additional validated company identifiers are detected", async () => {
    const entities = await detect(
      [
        "ABN 83 914 571 673",
        "Norwegian orgnr 923 609 016",
        "Norwegian VAT NO 995 525 828 MVA",
        "EIN 04-2103594",
      ].join("\n"),
    );
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "tax identification number",
          text: "83 914 571 673",
        }),
        expect.objectContaining({
          label: "registration number",
          text: "923 609 016",
        }),
        expect.objectContaining({
          label: "tax identification number",
          text: "NO 995 525 828 MVA",
        }),
        expect.objectContaining({
          label: "tax identification number",
          text: "04-2103594",
        }),
      ]),
    );
  });
});
