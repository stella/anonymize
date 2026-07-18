import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import { detectNative } from "./native-detect";

// Building the native prepared pipeline pays the regex-set DFA
// build cost once; 15 s gives headroom on CI without hiding real
// perf regressions.
setDefaultTimeout(15_000);
import type { PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const CONFIG: PipelineConfig = {
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
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "uk-financial-crime-test",
  dictionaries,
};

const run = (text: string) => detectNative(CONFIG, text);

describe("UK financial-crime additions", () => {
  test("UK postcode emits an address entity", async () => {
    const text = "The chambers are at 4 Pump Court, London EC4Y 7AN.";
    const ents = await run(text);
    const postcode = ents.find(
      (e) => e.label === "address" && e.text.includes("EC4Y"),
    );
    expect(postcode).toBeDefined();
  });

  test("NINO emits a social security number", async () => {
    // Sentence intentionally avoids the form `is AB <digits>`:
    // the Swedish `AB` legal-form detector would otherwise
    // back-extend across the preceding clause. The NINO regex
    // (with the stdnum gb.nino validator) handles the spaced
    // printed form that the bare stdnum pattern misses.
    const text =
      "The defendant's NINO HM 12 34 56 C was disclosed in evidence.";
    const ents = await run(text);
    const nino = ents.find(
      (e) =>
        e.label === "social security number" &&
        e.text.replace(/\s+/g, "") === "HM123456C",
    );
    expect(nino).toBeDefined();
  });

  test("NINO with invalid prefix is rejected by the stdnum validator", async () => {
    // BG/GB/KN/NK/NT/TN/ZZ are explicitly blocked prefixes
    // per HMRC; stdnum.gb.nino rejects them at validate().
    const text = "Reference ZZ 12 34 56 C is a placeholder.";
    const ents = await run(text);
    const nino = ents.find((e) => e.label === "social security number");
    expect(nino).toBeUndefined();
  });

  test("Companies House number after the trigger is captured", async () => {
    const text = "Acme Holdings Ltd (Companies House: 09876543) is the parent.";
    const ents = await run(text);
    const reg = ents.find(
      (e) => e.label === "registration number" && e.text === "09876543",
    );
    expect(reg).toBeDefined();
  });

  test("UTR after the trigger is captured as a tax id", async () => {
    const text = "Self Assessment UTR: 1234567890 was filed late.";
    const ents = await run(text);
    const utr = ents.find(
      (e) => e.label === "tax identification number" && e.text === "1234567890",
    );
    expect(utr).toBeDefined();
  });

  test("KC post-nominal anchors a bare two-word name as a person", async () => {
    const text =
      "The hearing was conducted before Lord Reed PC and submissions made by Jonathan Caplan KC.";
    const ents = await run(text);
    const person = ents.find(
      (e) => e.label === "person" && e.text.startsWith("Jonathan Caplan"),
    );
    expect(person).toBeDefined();
  });

  test("Serious Fraud Office redacts as an organization", async () => {
    const text = "The Serious Fraud Office opened a Section 2 investigation.";
    const ents = await run(text);
    const org = ents.find(
      (e) => e.label === "organization" && e.text.includes("Serious Fraud"),
    );
    expect(org).toBeDefined();
  });

  test("National Crime Agency redacts as an organization", async () => {
    // Bare 3-letter acronyms (NCA, SFO, FCA) are stripped by the
    // deny-list ALL_UPPER filter — known limitation. Full-name
    // forms are recognised reliably.
    const text =
      "Assets were seized following a National Crime Agency referral.";
    const ents = await run(text);
    const org = ents.find(
      (e) =>
        e.label === "organization" && e.text.includes("National Crime Agency"),
    );
    expect(org).toBeDefined();
  });
});
