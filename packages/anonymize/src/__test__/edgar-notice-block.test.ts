/**
 * Regressions from EDGAR EX-10 material contracts:
 * - Jasper Therapeutics registration-rights (2026-07-17): counsel
 *   notice-block names, "represented by Shares" person FPs, and
 *   jurisdiction soft-wrap across a single line break.
 * - Cadrenal Therapeutics separation agreement (2026-07-17):
 *   notice-paren person + email, generational suffix vs city
 *   district, and Dodd-Frank statute person FP.
 * - PEDEVCO separation agreement (2026-07-17): middle-initial
 *   honorific/notice names and dual `/s/` signatures on one line.
 * - Lightwave Logic employment agreement (2026-07-20): Attn given
 *   name corpus gap and middle-initial counsel vs US city tokens.
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

  test("notice-paren contact name before title and email is a person", async () => {
    const text = `You may revoke this Agreement by giving notice in writing
to the Company (Quang Pham, Chief Executive Officer, quang.pham@cadrenal.com)
by 5:00 p.m. ET on the seventh day.`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Quang Pham",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "email address" &&
          entity.text === "quang.pham@cadrenal.com",
      ),
    ).toBe(true);
  });

  test("generational suffix is not a city district after a person prefix", async () => {
    const text =
      "the “Company”), and James J. Ferguson III (hereinafter referred to as “you”)";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          (entity.text === "James J. Ferguson III" ||
            entity.text === "James J. Ferguson"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text === "Ferguson III",
      ),
    ).toBe(false);
  });

  test("Dodd-Frank Wall Street Reform is not a person", async () => {
    const text = `claims that you may have under the Dodd-Frank Wall Street
Reform and Consumer Protection Act.`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          (entity.text === "Frank Wall Street" ||
            entity.text === "Frank" ||
            entity.text.includes("Wall Street")),
      ),
    ).toBe(false);
  });

  test("middle initial after honorific stays in the person span", async () => {
    const text =
      "I must give written notice to Mr. Clark R. Moore of the Company";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Mr. Clark R. Moore",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "Moore",
      ),
    ).toBe(false);
  });

  test("middle initial between given name and surname is a person", async () => {
    const text =
      'between Paul A. Pinkston ("I" or "Employee"), and PEDEVCO Corp.';
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Paul A. Pinkston",
      ),
    ).toBe(true);
  });

  test("two slash-s signatures on one line are both people", async () => {
    const text = "/s/ Paul A. Pinkston /s/ Clark R. Moore";
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Paul A. Pinkston",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Clark R. Moore",
      ),
    ).toBe(true);
  });

  test("Attn given name and surname are both a person", async () => {
    const text = `Attn: Clint Calli

Email: clint.calli@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Clint Calli",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Calli",
      ),
    ).toBe(false);
  });

  test("Attn middle-initial counsel name beats nested city addresses", async () => {
    const text = `Attn: Clayton E. Parker, Esq.

Email: Clayton.Parker@example.com`;
    const entities = await detect(text);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Clayton E. Parker",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" &&
          (entity.text === "Clayton" || entity.text === "Parker"),
      ),
    ).toBe(false);
  });
});
