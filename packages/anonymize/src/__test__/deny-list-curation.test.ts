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
import addressStopwordsData from "../data/address-stopwords.json";
import commonWordsData from "../data/common-words-en.json";
import { buildDenyList } from "../detectors/deny-list";
import type { Entity, PipelineConfig } from "../types";
import type { PipelineContext } from "../context";
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

let dictionariesPromise: ReturnType<typeof loadTestDictionaries> | undefined;
const getDictionaries = () => {
  dictionariesPromise ??= loadTestDictionaries();
  return dictionariesPromise;
};

let sharedContext: PipelineContext | undefined;
const getContext = (): PipelineContext => {
  sharedContext ??= createPipelineContext();
  return sharedContext;
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context: getContext(),
  });
};

const SINGLE_WORD_RE = /^\p{L}+$/u;
const commonWords = new Set(
  commonWordsData.words.map((word) => word.toLowerCase()),
);

const toTitleCase = (word: string): string =>
  word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();

const asArray = <T>(value: T | T[] | undefined): readonly T[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

describe("deny-list curation", () => {
  test("curated common-word patterns are dropped before automaton build", async () => {
    const dictionaries = await getDictionaries();
    const data = await buildDenyList(
      { ...baseConfig, dictionaries },
      getContext(),
    );
    expect(data).not.toBeNull();
    if (!data) return;

    const leaked: string[] = [];
    for (const [index, original] of data.originals.entries()) {
      if (!SINGLE_WORD_RE.test(original)) continue;
      if (!commonWords.has(original.toLowerCase())) continue;

      const labels = asArray(data.labels[index]);
      if (labels.every((label) => label === "address")) {
        continue;
      }

      const sources = asArray(data.sources[index]);
      const hasCuratedSource = sources.some(
        (source) => source === "deny-list" || source === "surname",
      );
      if (!hasCuratedSource) continue;

      leaked.push(`${original}: ${labels.join(",")} (${sources.join(",")})`);
    }

    expect(leaked.slice(0, 20)).toEqual([]);
  });

  test("country-scoped city dictionaries shrink the deny-list pattern set", async () => {
    const dictionaries = await getDictionaries();
    const full = await buildDenyList(
      { ...baseConfig, dictionaries },
      createPipelineContext(),
    );
    const scoped = await buildDenyList(
      {
        ...baseConfig,
        dictionaries,
        denyListCountries: ["US"],
        nameCorpusLanguages: ["en"],
      },
      createPipelineContext(),
    );

    expect(full).not.toBeNull();
    expect(scoped).not.toBeNull();
    if (!full || !scoped) return;

    expect(scoped.originals.length).toBeLessThan(full.originals.length / 2);
    expect(scoped.originals).toContain("New York City");
    const grazCityIndex = scoped.originals.findIndex(
      (entry, index) =>
        entry === "Graz" && scoped.sources[index]?.includes("city"),
    );
    expect(grazCityIndex).toBe(-1);
  });

  test("address collision dictionary suppresses bare city-name legal terms", async () => {
    const dictionaries = await getDictionaries();
    const cityWords = new Set(
      (dictionaries.cities ?? []).map((city) => city.toLowerCase()),
    );
    const collisionWords = addressStopwordsData.words
      .filter((word) => cityWords.has(word))
      .slice(0, 24);
    expect(collisionWords.length).toBeGreaterThan(8);

    const text = collisionWords
      .map((word) => `${toTitleCase(word)} required.`)
      .join(" ");
    const entities = await detect(text);
    const leakedAddresses = entities
      .filter((entity) => entity.label === "address")
      .map((entity) => entity.text.toLowerCase())
      .filter((candidate) => collisionWords.includes(candidate));

    expect(leakedAddresses).toEqual([]);
  });

  test("real city mentions are not globally suppressed as common words", async () => {
    // `Vienna` is present in common-words-en because that
    // file includes high-frequency proper nouns. Address
    // suppression must therefore use the narrower
    // address-collision dictionary, not every common word.
    const entities = await detect("The meeting is in Vienna.");
    const vienna = entities.find(
      (entity) => entity.label === "address" && entity.text === "Vienna",
    );
    expect(vienna).toBeDefined();
  });

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

  test("post-money valuation term is not flagged as address", async () => {
    // `Post` exists as a small-city name in GeoNames.
    // In legal/finance prose, the hyphenated defined term
    // `Post-Money Valuation` is not a district-style address.
    const text =
      "The Post-Money Valuation Cap is 10.000.000 USD " +
      "(nine million dollars).";
    const entities = await detect(text);
    const addressTexts = new Set(
      entities.filter((e) => e.label === "address").map((e) => e.text),
    );
    expect(addressTexts.has("Post")).toBe(false);
    expect(addressTexts.has("Post-Money Valuation")).toBe(false);
  });

  test("creative commons license text is not flagged as person", async () => {
    // `Commons` is present in name data, but in this
    // title-case license phrase it is a common noun.
    const text =
      "This form is made available under a Creative Commons " +
      "Attribution-NoDerivatives 4.0 License.";
    const entities = await detect(text);
    const personTexts = new Set(
      entities.filter((e) => e.label === "person").map((e) => e.text),
    );
    expect(personTexts.has("Commons")).toBe(false);
    expect(personTexts.has("Commons Attribution-NoDerivatives")).toBe(false);
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

  test("name chain is suppressed inside defined-term quote", async () => {
    // "Blue" + "Sky" both case-fold to name-corpus tokens.
    // Inside a defined-term quote with a definitional cue
    // ("shall mean"), the chain must not emit as a person at
    // all. The phrase is legal terminology, not a name.
    const text = '"Blue Sky Laws" shall mean state securities laws.';
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Blue"),
    );
    expect(definedTermPerson).toBeUndefined();
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

  test("ordinary quoted person name still extends to unknown surname", async () => {
    // A plain quotation without a definitional cue is ordinary
    // prose, not a legal defined term. The fallback surname
    // extension must still protect the whole quoted name.
    const text = '"John Unknown" said the report was complete.';
    const entities = await detect(text);
    const fullName = entities.find(
      (e) => e.label === "person" && e.text === "John Unknown",
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

  test('quoted defined-term ("Bond Hedge Transactions") is not emitted as a person', async () => {
    // Inside a typographic-quote defined-term clause, the
    // person chain emission must not produce a partial
    // person span from the name-corpus tokens.
    const text =
      "“Bond Hedge Transactions” shall mean the call option transactions.";
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Bond"),
    );
    expect(definedTermPerson).toBeUndefined();
  });

  test("real person name inside defined-term quote is still emitted", async () => {
    const text =
      '"John Smith" shall mean the employee named in this Agreement.';
    const entities = await detect(text);
    const person = entities.find(
      (e) => e.label === "person" && e.text === "John Smith",
    );
    expect(person).toBeDefined();
  });

  test("longer real person name inside defined-term quote is still emitted", async () => {
    const text =
      '"John Michael Smith" shall mean the employee named in this Agreement.';
    const entities = await detect(text);
    const person = entities.find(
      (e) => e.label === "person" && e.text === "John Michael Smith",
    );
    expect(person).toBeDefined();
  });

  test("possessive inside defined-term quote does not hide the quote boundary", async () => {
    const text =
      '"Borrower\'s Blue Sky Laws" shall mean state securities laws.';
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Blue"),
    );
    expect(definedTermPerson).toBeUndefined();
  });

  test("first-name legal term is suppressed without a role definition", async () => {
    const text = '"Bond Hedge" shall mean state securities laws.';
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Bond"),
    );
    expect(definedTermPerson).toBeUndefined();
  });

  test("prefixed defined-term quote is suppressed even when name hit is not first", async () => {
    const text = '"Applicable Blue Sky Laws" shall mean state securities laws.';
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Blue"),
    );
    expect(definedTermPerson).toBeUndefined();
  });

  test("German quote and plural meaning cue are treated as defined-term syntax", async () => {
    const text =
      "„Blue Sky Laws“ shall have the meanings set forth in Section 1.1.";
    const entities = await detect(text);
    const definedTermPerson = entities.find(
      (e) => e.label === "person" && e.text.includes("Blue"),
    );
    expect(definedTermPerson).toBeUndefined();
  });
});
