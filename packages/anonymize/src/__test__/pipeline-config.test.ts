import { describe, expect, test } from "bun:test";

import { createPipelineContext, runPipeline } from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

let dictionaries: Dictionaries;
const getDictionaries = async () => {
  if (!dictionaries) dictionaries = await loadTestDictionaries();
  return dictionaries;
};

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [],
  workspaceId: "test",
};

const detect = async (fullText: string, config: Partial<PipelineConfig>) =>
  runPipeline({
    fullText,
    config: {
      ...BASE_CONFIG,
      ...config,
    },
    gazetteerEntries: [],
    context: createPipelineContext(),
  });

describe("pipeline config semantics", () => {
  test("empty labels do not suppress deterministic detectors", async () => {
    const entities = await detect("Datum narození: 2024-01-02", {
      enableRegex: true,
      labels: [],
    });
    expect(entities.some((entity) => entity.label === "date")).toBe(true);
  });

  test("labels filter applies to deterministic detectors", async () => {
    const entities = await detect("Datum narození: 2024-01-02", {
      enableRegex: true,
      labels: ["person"],
    });
    expect(entities).toHaveLength(0);
  });

  test("enableLegalForms flag gates legal-form detection", async () => {
    const withFlag = await detect("Acme s.r.o.", {
      enableLegalForms: true,
      labels: ["organization"],
    });
    expect(withFlag.some((entity) => entity.label === "organization")).toBe(
      true,
    );

    const withoutFlag = await detect("Acme s.r.o.", {
      enableLegalForms: false,
      labels: ["organization"],
    });
    expect(withoutFlag).toHaveLength(0);
  });

  test("legacy configs without enableLegalForms keep legal-form detection enabled", async () => {
    const entities = await runPipeline({
      fullText: "Acme s.r.o.",
      config: {
        ...BASE_CONFIG,
        enableLegalForms: undefined,
        labels: ["organization"],
      } as unknown as PipelineConfig,
      gazetteerEntries: [],
      context: createPipelineContext(),
    });
    expect(entities.some((entity) => entity.label === "organization")).toBe(
      true,
    );
  });

  test("enableNameCorpus disables name matches in deny-list mode", async () => {
    const entities = await detect("Jan Novak", {
      enableDenyList: true,
      enableNameCorpus: false,
      denyListCountries: ["CZ"],
      labels: ["person"],
      dictionaries: await getDictionaries(),
    });
    expect(entities).toHaveLength(0);
  });

  test("enableNameCorpus keeps name matches available in deny-list mode", async () => {
    const entities = await detect("Jan Novak", {
      enableDenyList: true,
      enableNameCorpus: true,
      denyListCountries: ["CZ"],
      labels: ["person"],
      dictionaries: await getDictionaries(),
    });
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Jan Novak",
      ),
    ).toBe(true);
  });

  test("hotword reclassification can promote filtered source labels into requested output labels", async () => {
    const entities = await detect("narozen dne 12.03.1990 v Praze", {
      enableRegex: true,
      enableHotwordRules: true,
      labels: ["date of birth"],
    });
    expect(
      entities.some(
        (entity) =>
          entity.label === "date of birth" && entity.text === "12.03.1990",
      ),
    ).toBe(true);
  });

  test("address seed expansion keeps unfiltered NER boundaries in context", async () => {
    const fullText = "Jan Novák, Olbrachtova 1929/62, 140 00 Praha 4";
    const personEnd = fullText.indexOf(",");
    const entities = await runPipeline({
      fullText,
      config: {
        ...BASE_CONFIG,
        enableNer: true,
        labels: ["address"],
      },
      gazetteerEntries: [],
      context: createPipelineContext(),
      nerInference: async () => [
        {
          start: 0,
          end: personEnd,
          label: "person",
          text: fullText.slice(0, personEnd),
          score: 0.95,
          source: "ner",
        },
      ],
    });
    const address = entities.find((entity) => entity.label === "address");
    expect(address).toBeDefined();
    expect(address!.text).toContain("Olbrachtova 1929/62");
    expect(address!.text).toContain("140 00 Praha 4");
    expect(address!.text).not.toContain("Jan Novák");
  });

  test("address-only output still respects non-address bounds during seed expansion", async () => {
    const entities = await detect(
      "Acme s.r.o., Dělnická 213/12, 170 00 Praha 7",
      {
        enableLegalForms: true,
        labels: ["address"],
      },
    );
    const address = entities.find((entity) => entity.label === "address");
    expect(address).toBeDefined();
    expect(address!.text).toContain("Dělnická 213/12");
    expect(address!.text).toContain("Praha 7");
    expect(address!.text).not.toContain("Acme");
  });
});
