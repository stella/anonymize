/**
 * Regression tests for legal-form ORG over-extension. Two distinct
 * root causes had stacked up:
 *
 * 1. The suffix word-boundary lookahead was `(?![${LOWER}])`, which
 *    forbade only a following lowercase letter. Short all-caps legal
 *    forms (`AG`, `SA`, `SC`, `GP`, `NL`, `PA`, `AD`, …) would
 *    therefore happily match the first two or three characters of
 *    common English ALL-CAPS words: `AG` in `AGREEMENT`, `PA` in
 *    `PARTIES`, `AD` in `ADDRESS`, `SC` in `SCHEDULE`. The fix
 *    tightens the lookahead to `(?![${LOWER}${UPPER}\p{N}])` so the
 *    suffix has a real word boundary on its trailing side.
 *
 * 2. The leading-clause trim's comma gate required a literal comma
 *    immediately before `between` / `among` / `amongst` (intended to
 *    protect in-name uses like `Food For Thought Among Friends LLC`).
 *    Real contract prose drops the comma in the same construction:
 *    `This Agreement is entered into between Acme Inc.` The fix
 *    lifts the comma gate when a sentence verb (`is`, `entered`,
 *    `are`, …) appears in the preceding text — the verb is the
 *    structural cue that this is a clause connector, not an in-name
 *    component.
 *
 * Both fixes are span-discipline changes; neither widens what counts
 * as a legal-form suffix or as an org name.
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
  workspaceId: "legal-form-no-over-extension-test",
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

describe("legal-form ORG span discipline — suffix word boundary", () => {
  test("'AG' suffix does not match the first two chars of 'AGREEMENT'", async () => {
    const text =
      "Beta LLC. The INITIAL TERM described in 5.1, this AGREEMENT shall apply.";
    const entities = await detect(text);
    const spurious = orgs(entities).find((e) => e.text.includes("AGREEMENT"));
    expect(spurious).toBeUndefined();
    const beta = orgs(entities).find((e) => e.text === "Beta LLC");
    expect(beta).toBeDefined();
  });

  test("'PA' suffix does not match the first two chars of 'PARTIES'", async () => {
    const text = "THIRD PARTIES shall not benefit hereunder.";
    const entities = await detect(text);
    const spurious = orgs(entities).find((e) => e.text.includes("PARTIES"));
    expect(spurious).toBeUndefined();
  });

  test("'AD' suffix does not match the first two chars of 'ADDRESS'", async () => {
    const text = "NEED ADDRESS for notices.";
    const entities = await detect(text);
    const spurious = orgs(entities).find((e) => e.text.includes("ADDRESS"));
    expect(spurious).toBeUndefined();
  });

  test("ALL-CAPS sentence tail 'this AGREEMENT' is never tagged as an org", async () => {
    const text = "For the purposes of this AGREEMENT, the parties agree.";
    const entities = await detect(text);
    const spurious = orgs(entities).find(
      (e) => e.text.includes("this AGREEMENT") || e.text.includes("AGREEMENT"),
    );
    expect(spurious).toBeUndefined();
  });

  test("legitimate short all-caps suffix still matches", async () => {
    // The fix must not break real "Apple AG" / "Samsung SE" matches.
    const text = "Apple AG and Samsung SE filed jointly.";
    const entities = await detect(text);
    const appleAg = orgs(entities).find((e) => e.text === "Apple AG");
    const samsungSe = orgs(entities).find((e) => e.text === "Samsung SE");
    expect(appleAg).toBeDefined();
    expect(samsungSe).toBeDefined();
  });

  test("short suffix followed by an accented Latin letter is rejected", async () => {
    // `AG` would match the leading two chars of `AGÊNCIA` under the
    // ASCII-only regex boundary; the post-match accented-letter
    // check rejects it.
    const text = "Os usuários do Minha AGÊNCIA aceitam estes termos.";
    const entities = await detect(text);
    const spurious = orgs(entities).find((e) => /\bAG$/.test(e.text));
    expect(spurious).toBeUndefined();
  });

  test("short suffix in 'PLANO DE SAÚDE' is rejected by the post-match boundary", async () => {
    const text = "Bonus para o PLANO DE SAÚDE empresarial.";
    const entities = await detect(text);
    const spurious = orgs(entities).find((e) => /\bSA$/.test(e.text));
    expect(spurious).toBeUndefined();
  });
});

describe("legal-form ORG span discipline — clause-connector trim", () => {
  test("'between' inside a prose sentence is trimmed even without a comma", async () => {
    const text = "This Agreement is entered into between Acme Inc.";
    const entities = await detect(text);
    const acme = orgs(entities).find((e) => e.text === "Acme Inc.");
    expect(acme).toBeDefined();
    const over = orgs(entities).find((e) =>
      e.text.toLowerCase().startsWith("this agreement"),
    );
    expect(over).toBeUndefined();
  });

  test("'entered into between' clause is trimmed even with no other verb", async () => {
    // The preamble has no `is` / `was`; only `entered` carries the
    // clause-prose signal. Verb data needs to include it.
    const text = "This Agreement, entered into between Acme Inc.";
    const entities = await detect(text);
    const acme = orgs(entities).find((e) => e.text === "Acme Inc.");
    expect(acme).toBeDefined();
    const over = orgs(entities).find((e) =>
      e.text.toLowerCase().startsWith("this agreement"),
    );
    expect(over).toBeUndefined();
  });

  test("'between' inside a company name still keeps the full name", async () => {
    // "The Space In Between LLC" — "between" is an in-name word, not
    // a clause connector. No sentence verb appears before it, so the
    // comma gate keeps protecting the full span.
    const text = "The Space In Between LLC operates here.";
    const entities = await detect(text);
    const fullName = orgs(entities).find((e) =>
      e.text.includes("The Space In Between LLC"),
    );
    expect(fullName).toBeDefined();
  });

  test("'Among' inside a company name still keeps the full name", async () => {
    const text = "Food For Thought Among Friends LLC was incorporated in 2010.";
    const entities = await detect(text);
    const fullName = orgs(entities).find((e) =>
      e.text.includes("Food For Thought Among Friends LLC"),
    );
    expect(fullName).toBeDefined();
  });

  test("title-case verb-like token inside a company name does not trip the verb gate", async () => {
    // `Is` is a sentence-verb indicator but here appears title-cased
    // inside the company name. The verb gate must only count lowercase
    // verb forms; title-cased verb words are in-name capitalisation,
    // and the comma gate keeps protecting the full span.
    const text = "Everything Is Better Between Friends LLC operates here.";
    const entities = await detect(text);
    const fullName = orgs(entities).find((e) =>
      e.text.includes("Everything Is Better Between Friends LLC"),
    );
    expect(fullName).toBeDefined();
    const trimmedSpurious = orgs(entities).find(
      (e) => e.text === "Friends LLC",
    );
    expect(trimmedSpurious).toBeUndefined();
  });

  // NATIVE-GAP: with a long comma-laden leading clause
  // ("Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.")
  // the native leading-clause trim drops the candidate entirely and emits no
  // organization. Shorter leading contexts (", among Twitter, Inc." and
  // "among Twitter, Inc.") trim back to "Twitter, Inc." correctly, so the gap
  // is specific to trimming a long multi-comma preamble.
  test("comma-preceded 'among' continues to trim leading clause", async () => {
    // Existing behaviour: "..., among Twitter, Inc." should trim
    // back to "Twitter, Inc." This is the case the comma gate was
    // originally built for.
    const text =
      "Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    const entities = await detect(text);
    const twitter = orgs(entities).find((e) =>
      e.text.includes("Twitter, Inc."),
    );
    expect(twitter).toBeDefined();
    const over = orgs(entities).find((e) =>
      e.text.toLowerCase().includes("investment agreement, dated"),
    );
    expect(over).toBeUndefined();
  });
});
