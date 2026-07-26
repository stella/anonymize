import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { Dictionaries, PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(60_000);

const CONFIG: PipelineConfig = {
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
  denyListCountries: ["CZ"],
  nameCorpusLanguages: ["cs"],
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "doc-scaffold-fp-test",
};

let cachedDictionaries: Dictionaries | undefined;
const detect = async (text: string) => {
  cachedDictionaries ??= await loadTestDictionaries();
  return detectNative({ ...CONFIG, dictionaries: cachedDictionaries }, text);
};

describe("document scaffolding false positives", () => {
  test("section markers and numbered page footers are not PII", async () => {
    const text =
      "Místo plnění\n\n6.1. Místem plnění se rozumí: Technická správa města\n\nStrana 7 (celkem 7)\nStrany 4 (celkem 9)\nStran celkem 9";
    const entities = await detect(text);
    expect(
      entities.some((e) => e.label === "address" && e.text.trim() === "6.1"),
    ).toBe(false);
    expect(
      entities.some(
        (e) =>
          e.label === "organization" &&
          /^(?:Stran(?:a|y)?\s+\d+|Stran celkem \d+)$/u.test(e.text),
      ),
    ).toBe(false);
  });

  test("ordinary municipality organization trigger is unchanged", async () => {
    const text = "město Brandýs nad Labem, IČO: 00240066";
    const entities = await detect(text);
    expect(
      entities.some(
        (e) =>
          e.label === "organization" && e.text.includes("Brandýs nad Labem"),
      ),
    ).toBe(true);
  });
});
