/**
 * Organization cues that are also legal-form suffixes must not run as
 * prefix extractors. Legal-form detection owns left-extension for those
 * phrases; prefix capture after a suffix cue swallows trailing prose.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";
import { detectNative } from "./native-detect";

setDefaultTimeout(60_000);

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
  workspaceId: "legal-form-suffix-org-trigger",
  languages: ["cs"],
  nameCorpusLanguages: ["cs"],
  denyListCountries: ["CZ"],
};

let dictionariesPromise: Promise<Dictionaries> | undefined;
const getDictionaries = (): Promise<Dictionaries> => {
  dictionariesPromise ??= loadTestDictionaries();
  return dictionariesPromise;
};

const detect = async (text: string): Promise<NativePipelineEntity[]> =>
  detectNative({ ...baseConfig, dictionaries: await getDictionaries() }, text);

const organizations = async (text: string): Promise<string[]> =>
  (await detect(text))
    .filter(({ label }) => label === "organization")
    .map(({ text: entityText }) => entityText);

describe("legal-form suffix must not act as organization prefix cue", () => {
  test("Czech contribution-organization header does not capture list prose", async () => {
    const text = [
      "14|15 Baťův institut, příspěvková organizace",
      "",
      "          c)    Fáze uvedení díla do provozu",
      "",
      "VII.     Platební podmínky",
    ].join("\n");

    const orgs = await organizations(text);
    expect(orgs.some((value) => value === "c")).toBe(false);
    expect(orgs.some((value) => value.includes("Platební"))).toBe(false);
    expect(orgs.some((value) => value.includes("Fáze"))).toBe(false);
    expect(
      orgs.some((value) =>
        value.includes("Baťův institut, příspěvková organizace"),
      ),
    ).toBe(true);
  });

  test("vocabulary-driven school prefix still captures the following name", async () => {
    // Negative control: an institution prefix that is not a legal-form
    // suffix keeps to-next-comma extraction.
    const orgs = await organizations("základní škola Husova\n");
    expect(orgs).toContain("Husova");
  });

  test("legal-form company cue still detects the organization via legal forms", async () => {
    // Negative control: unrelated legal-form detection is unchanged.
    const orgs = await organizations("Dodavatel: Acme Consulting s.r.o.\n");
    expect(orgs.some((value) => value.includes("Acme Consulting"))).toBe(true);
  });

  test("place-of-performance heading does not capture section marker as address", async () => {
    const text = [
      "Sídlo: Vavrečkova 7040, 760 01 Zlín",
      "",
      "V.   Místo plnění",
      "V.1.    Podrobné vymezení místa realizace díla je obsaženo v dokumentaci.",
      "",
      "Místo plnění: náměstí Míru 1, 767 01 Kroměříž",
    ].join("\n");

    const addresses = (await detect(text))
      .filter(({ label }) => label === "address")
      .map(({ text: entityText }) => entityText);

    expect(addresses).not.toContain("V.1");
    expect(addresses.some((value) => value.includes("Vavrečkova"))).toBe(true);
    expect(addresses.some((value) => value.includes("náměstí Míru"))).toBe(
      true,
    );
  });
});
