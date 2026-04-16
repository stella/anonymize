import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { PipelineConfig } from "../types";

const CONFIG: PipelineConfig = {
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
  workspaceId: "contract-quality-test",
};

const detect = async (text: string) =>
  runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: createPipelineContext(),
  });

describe("contract quality regressions", () => {
  test("keeps person names with middle initials", async () => {
    const entities = await detect(
      "This Employment Agreement is between PRA Group, Inc. and Vikram A. Atal.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" && entity.text === "PRA Group, Inc.",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text === "Vikram A. Atal",
      ),
    ).toBe(true);
  });

  test("rejects sentence fragments chained into person names", async () => {
    const entities = await detect(
      "(e)Employee Benefits. In addition to the compensation discussed above.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text.includes("Benefits. In"),
      ),
    ).toBe(false);
  });

  test("rejects organization-like person phrases", async () => {
    const entities = await detect(
      "The Monthly COBRA Reimbursement shall remain in effect during the COBRA Reimbursement Period. The American Arbitration Association shall administer the arbitration.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "person" &&
          (entity.text === "COBRA Reimbursement Period" ||
            entity.text === "American Arbitration Association"),
      ),
    ).toBe(false);
  });

  test("stops trigger extraction at tab-separated columns", async () => {
    const entities = await detect(
      "Název firmy:\tPROBO-NB s.r.o.\tkontaktní osoba: Petr Machara\te-mail: machara@probo-nb.cz",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" && entity.text === "PROBO-NB s.r.o.",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "person" && entity.text.includes("e-mail:"),
      ),
    ).toBe(false);
  });

  test("rejects signing-clause pseudo-addresses", async () => {
    const entities = await detect(
      "V Brně dne 1. 1. 2026 V Praze, dne 2. 2. 2026",
    );

    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "V Brně dne",
      ),
    ).toBe(false);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text === "V Praze, dne",
      ),
    ).toBe(false);
  });

  test("rejects single-letter court section markers as registration numbers", async () => {
    const entities = await detect(
      "zapsaná v OR vedeném u Krajského soudu v Brně, oddíl C, vložka 30549",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "registration number" && entity.text === "C",
      ),
    ).toBe(false);
  });

  test("rejects short alphabetic court markers as registration numbers", async () => {
    const entities = await detect(
      "zapsaná pod spisovou značkou Pr 5968 u Městského soudu v Praze",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "registration number" && entity.text === "Pr",
      ),
    ).toBe(false);
  });

  test("does not emit standalone Republic as an address", async () => {
    const entities = await detect("Sanofi Czech Republic s.r.o.");

    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "Republic",
      ),
    ).toBe(false);
    expect(
      entities.some(
        (entity) =>
          entity.label === "organization" &&
          entity.text === "Sanofi Czech Republic s.r.o.",
      ),
    ).toBe(true);
  });

  test("does not emit pagination markers as addresses", async () => {
    const entities = await detect("Page Follows");

    expect(entities.some((entity) => entity.label === "address")).toBe(false);
  });

  test("does not emit generic Czech heading words as addresses", async () => {
    const entities = await detect("Lhůta pro doručení činí 10 dní.");

    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "Lhůta",
      ),
    ).toBe(false);
  });

  test("skips party-role prefixes before addresses", async () => {
    const entities = await detect(
      "Místem předání je sídlo prodávajícího Na Květnici 1657/16, 140 00 Praha 4.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "address" &&
          entity.text === "Na Květnici 1657/16, 140 00 Praha 4",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "address" &&
          entity.text.startsWith("prodávajícího "),
      ),
    ).toBe(false);
  });

  test("stops address entities at the next sentence", async () => {
    const entities = await detect(
      "Zboží si bude kupující vyzvedávat osobně na adrese U Náspu 5, Liberec. Přílohou faktury bude seznam odebraného zboží.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text.includes("Přílohou"),
      ),
    ).toBe(false);
  });

  test("does not extend dates into html entities", async () => {
    const entities = await detect(
      "Employee has pre-scheduled vacation from July 1 &#150; 15, 2022.",
    );

    expect(
      entities.some(
        (entity) => entity.label === "date" && entity.text.includes("&#"),
      ),
    ).toBe(false);
  });

  test("keeps address continuations after street abbreviations", async () => {
    const entities = await detect(
      "The employee is residing at 123 Main St. Suite 100.",
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "address" && entity.text.includes("Suite 100"),
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "address" && entity.text === "123 Main St",
      ),
    ).toBe(false);
  });

  test("rejects all-caps document headings as organizations", async () => {
    const entities = await detect(
      "THIS AMENDMENT NO. 1 TO AMENDED AND RESTATED EMPLOYMENT AGREEMENT",
    );

    expect(entities.some((entity) => entity.label === "organization")).toBe(
      false,
    );
  });
});
