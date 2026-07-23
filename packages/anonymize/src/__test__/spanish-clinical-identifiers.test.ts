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
  workspaceId: "spanish-clinical-identifiers-test",
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(TRIGGERS_ONLY_CONFIG, fullText);

describe("Spanish clinical identifier triggers", () => {
  test.each([
    ["Número de historia clínica: HC-704193", "HC-704193"],
    ["numero de historia clinica HC-820415", "HC-820415"],
    ["número de paciente PAC-310862", "PAC-310862"],
    ["Tarjeta sanitaria TS-9284017", "TS-9284017"],
  ] as const)("%s captures the identifier", async (text, expected) => {
    expect(await detect(text)).toEqual([
      expect.objectContaining({
        label: "registration number",
        text: expected,
      }),
    ]);
  });

  test.each([
    "El campo número de paciente quedó vacío.",
    "El manual solo describe la tarjeta sanitaria.",
    "Número de historia clínica: no consta.",
  ] as const)(
    "does not capture prose without an identifier: %s",
    async (text) => {
      expect(await detect(text)).toEqual([]);
    },
  );
});
