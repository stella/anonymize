/**
 * Regression tests for deny-list dictionary curation:
 * common English nouns must not surface as `person` /
 * `organization` simply because their case-folded form
 * appears in a name corpus, an EU acronym list, or a
 * lowercase bank seed.
 *
 * Each test uses short synthetic English text that
 * exercises the cluster without depending on any large
 * fixture.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";
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
  workspaceId: "deny-list-curation-test",
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

describe("deny-list curation", () => {
  test("single-token English nouns are not flagged as person", async () => {
    // Each highlighted word case-folds to a name-corpus entry
    // but is a plain English noun in legal prose.
    const text =
      "Antitrust Laws. Blue Sky Laws. Termination Fee. Debt Commitment " +
      "Letters. COVID-19 Measures. Vote Required clauses.";
    const entities = await detect(text);
    const personTexts = new Set(
      entities.filter((e) => e.label === "person").map((e) => e.text),
    );
    for (const noun of ["Laws", "Fee", "Letters", "Measures", "Vote"]) {
      expect(personTexts.has(noun)).toBe(false);
    }
  });

  test('bare "Bank" is not flagged as organization in defined-term context', async () => {
    // PL bank list previously contained the lowercase
    // pattern "bank", colliding with any capitalised
    // occurrence under case-insensitive AC search.
    const text =
      '"Bank Debt Commitment Letter" shall have the meaning ' +
      "set forth in Section 5.4.";
    const entities = await detect(text);
    const bankAlone = entities.find(
      (e) => e.label === "organization" && e.text === "Bank",
    );
    expect(bankAlone).toBeUndefined();
  });

  test('bare "Oil" is not flagged in compound-noun context', async () => {
    // EU institutions list contained "OIL" (Office for
    // Infrastructure and Logistics in Luxembourg); under
    // case-insensitive AC it matched "Oil" in prose.
    const text = "The National Oil and Hazardous Substances Pollution Plan.";
    const entities = await detect(text);
    const oilAlone = entities.find((e) => e.text === "Oil");
    expect(oilAlone).toBeUndefined();
  });

  test("name chain stops at allow-listed noun inside defined-term quote", async () => {
    // "Blue" + "Sky" both case-fold to name-corpus tokens.
    // Inside a defined-term quote with a definitional cue
    // ("shall mean"), the chain emission must not promote
    // "Laws" into the span.
    const text = '"Blue Sky Laws" shall mean state securities laws.';
    const entities = await detect(text);
    const includesLaws = entities.some(
      (e) => e.label === "person" && e.text.includes("Laws"),
    );
    expect(includesLaws).toBe(false);
  });

  test("ordinary person name extends past allow-listed common-word surname", async () => {
    // Real surnames like "Law" or "Tesla" appear on the
    // global allow list to suppress single-token noise, but
    // they are legitimate extensions when preceded by a
    // first name in plain prose. The fallback must absorb
    // them; otherwise the emitted entity would end at the
    // first name and leave the surname un-anonymised.
    const text = "John Law signed the report on Monday.";
    const entities = await detect(text);
    const fullName = entities.find(
      (e) => e.label === "person" && e.text === "John Law",
    );
    expect(fullName).toBeDefined();
  });

  test("trailing curly closing quote is stripped during person extension", async () => {
    // Before the fix, `extendPersonName` stripped only
    // `[,;.]` and missed `”`, so the curly-quoted
    // defined term swallowed the trailing quote and bypassed
    // the allow-list check.
    const text = "“Blue Sky Laws” shall mean state securities laws.";
    const entities = await detect(text);
    const withTrailingQuote = entities.some((e) => /[”"’']$/.test(e.text));
    expect(withTrailingQuote).toBe(false);
  });

  test('quoted defined-term ("Bond Hedge Transactions") does not extend beyond chain', async () => {
    // Inside a typographic-quote defined-term clause, the
    // person chain emission must not promote the trailing
    // English noun into the span. The deny-list detector
    // skips the extend step when the chain start follows
    // an opening quote.
    const text =
      "“Bond Hedge Transactions” shall mean the call option transactions.";
    const entities = await detect(text);
    const withTransactions = entities.some(
      (e) => e.label === "person" && e.text.includes("Transactions"),
    );
    expect(withTransactions).toBe(false);
  });
});
