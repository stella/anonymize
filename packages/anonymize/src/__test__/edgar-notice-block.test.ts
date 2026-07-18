/**
 * Regressions from an EDGAR EX-10 registration-rights agreement
 * (Jasper Therapeutics, filed 2026-07-17): notice-block counsel
 * names, "represented by Shares" person FPs, and jurisdiction
 * soft-wrap across a single line break.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "edgar-notice-block-test",
  languages: ["en"],
  denyListCountries: ["US"],
  nameCorpusLanguages: ["en"],
};

const detect = async (text: string): Promise<NativePipelineEntity[]> => {
  const dictionaries = await loadTestDictionaries({
    denyListCountries: ["US"],
    nameCorpusLanguages: ["en"],
  });
  return detectNative({ ...baseConfig, dictionaries }, text);
};

describe("EDGAR notice-block and securities-clause regressions", () => {
  test("counsel name above law-firm contact block is a person", async () => {
    const text = `PLEASE EMAIL OR FAX A COPY OF THE COMPLETED AND EXECUTED NOTICE
AND QUESTIONNAIRE, AND RETURN THE ORIGINAL BY OVERNIGHT MAIL, TO:

Dylan Caplan

DLA Piper LLP (US)

Fax +1 215 606 2168

ProjectComplement-DLACore@us.dlapiper.com`;
    const entities = await detect(text);
    const person = entities.find(
      (entity) => entity.label === "person" && entity.text === "Dylan Caplan",
    );
    expect(person).toBeDefined();
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text.includes("DLA Piper LLP"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "email address" &&
          entity.text === "ProjectComplement-DLACore@us.dlapiper.com",
      ),
    ).toBe(true);
  });

  test("represented by Shares is not a person", async () => {
    const text =
      "any Registrable Securities represented by Shares applied to the Holders on a pro rata basis";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Shares",
      ),
    ).toBe(false);
  });

  test("State of New York survives a single EDGAR line wrap", async () => {
    const text =
      "exclusive jurisdiction of the courts of the State of New\nYork for the purposes of any suit";
    const entities = await detect(text);
    const juris = entities.find(
      (entity) =>
        entity.label === "address" && entity.text.startsWith("State of"),
    );
    expect(juris?.text.replaceAll(/\s+/g, " ")).toBe("State of New York");
    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "York",
      ),
    ).toBe(false);
  });
});
