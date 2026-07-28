/**
 * Institution-style organization cues often sit at the end of a party
 * name line. Without a cross-line guard, to-next-comma trims the newline
 * and absorbs the next form field (seat/address) as an organization.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { Dictionaries, PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
  threshold: 0.3,
  languages: ["cs"],
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
  denyListCountries: ["CZ"],
  nameCorpusLanguages: ["cs"],
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "org-institution-newline-fp",
};

let dictionariesPromise: Promise<Dictionaries> | undefined;
const getDictionaries = (): Promise<Dictionaries> => {
  dictionariesPromise ??= loadTestDictionaries();
  return dictionariesPromise;
};

const detect = async (fullText: string): Promise<NativePipelineEntity[]> => {
  const dictionaries = await getDictionaries();
  return detectNative({ ...baseConfig, dictionaries }, fullText);
};

const orgs = (entities: NativePipelineEntity[]): NativePipelineEntity[] =>
  entities.filter((e) => e.label === "organization");

const addresses = (entities: NativePipelineEntity[]): NativePipelineEntity[] =>
  entities.filter((e) => e.label === "address");

describe("institution org cue does not absorb the next-line seat field", () => {
  test("Czech regression: příspěvková organizace leaves se sídlem address intact", async () => {
    const text = [
      "Muzeum Těšínska, příspěvková organizace",
      "se sídlem:                        Masarykovy sady 103/19, 737 01 Český Těšín",
      "IČO:                              00305847",
    ].join("\n");
    const entities = await detect(text);
    expect(
      orgs(entities).some((e) => /sídlem|Masarykovy sady/u.test(e.text)),
    ).toBe(false);
    expect(
      addresses(entities).some((e) =>
        e.text.includes("Masarykovy sady 103/19"),
      ),
    ).toBe(true);
    expect(
      addresses(entities).some((e) => e.text.includes("Český Těšín")),
    ).toBe(true);
  });

  test("vocabulary-driven positive: nadace keeps next-line uppercase org name", async () => {
    // `nadace` is an institution cue in triggers.cs.json; it is not named in
    // the Rust cross-line guard.
    const text = "Partnerem je nadace\nČlověk v tísni, Praha";
    const entities = await detect(text);
    expect(orgs(entities).some((e) => e.text.includes("Člověk v tísni"))).toBe(
      true,
    );
  });

  test("negative control: municipality org trigger is unchanged", async () => {
    const text = "město Brandýs nad Labem, IČO: 00240066";
    const entities = await detect(text);
    expect(
      orgs(entities).some((e) => e.text.includes("Brandýs nad Labem")),
    ).toBe(true);
  });
});
