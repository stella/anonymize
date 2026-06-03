/**
 * Regression tests for v2 legal-form span discipline. Each test pins
 * a specific class of over-extension or under-extension the v2 walker
 * has to handle:
 *
 *   - dotted-citation boundary (`18 U.S.C.` must not yield `U.S.C.`)
 *   - indented line-wrap (`Goldman Sachs & Co.\n  LLC` is one span)
 *   - semicolon hard stop
 *   - embedded-list split between two complete suffix items
 *   - prose-verb trim back to the real org name
 *   - prose-only sentence ending in a legal-form descriptor
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, Entity, PipelineConfig } from "../types";
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
  workspaceId: "legal-forms-v2-span-discipline",
};

let dictionariesPromise: Promise<Dictionaries> | undefined;
const getDictionaries = (): Promise<Dictionaries> => {
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

const orgs = (entities: Entity[]): Entity[] =>
  entities.filter((e) => e.label === "organization");

describe("v2 legal-form span discipline — dotted-citation boundary", () => {
  test("`18 U.S.C.` does not produce a `U.S.C.` organisation", async () => {
    // The suffix lexicon contains short dotted forms (`S.A.`, `S.C.`)
    // that AC will happily match inside longer citation chains. The
    // leading-separator check has to reject a hit whose previous
    // character is a dot preceded by a Latin letter.
    const text = "See 18 U.S.C. Section 1833(b) for civil immunity.";
    const spurious = orgs(await detect(text)).find((e) =>
      e.text.includes("U.S.C."),
    );
    expect(spurious).toBeUndefined();
  });
});

describe("v2 legal-form span discipline — line-wrap allowance", () => {
  test("indented suffix on the next line keeps the line-wrap span", async () => {
    // EDGAR HTML reflows a terminal suffix onto its own line and
    // preserves the indentation. The line-wrap branch has to skip
    // leading horizontal whitespace before checking for `\n`.
    const text =
      "The underwriter is Goldman Sachs & Co.\n  LLC, joint book-runner.";
    const hit = orgs(await detect(text)).find((e) =>
      e.text.replace(/\s+/g, " ").includes("Goldman Sachs & Co. LLC"),
    );
    expect(hit).toBeDefined();
  });
});

describe("v2 legal-form span discipline — embedded-list split", () => {
  test("`Acme LLC, Beta Inc.` splits into two organisations", async () => {
    const text = "The parties include Acme LLC, Beta Inc. and others.";
    const entities = orgs(await detect(text));
    const merged = entities.find((e) => e.text.includes("Acme LLC, Beta Inc."));
    expect(merged).toBeUndefined();
    const acme = entities.find((e) => e.text.endsWith("Acme LLC"));
    const beta = entities.find((e) => e.text === "Beta Inc.");
    expect(acme).toBeDefined();
    expect(beta).toBeDefined();
  });
});

describe("v2 legal-form span discipline — semicolon hard stop", () => {
  test("semicolon between a party label and a company name is a boundary", async () => {
    const text = "Definitions: 'Seller'; Acme Inc. of Delaware.";
    const overrun = orgs(await detect(text)).find((e) =>
      e.text.includes("Seller"),
    );
    expect(overrun).toBeUndefined();
    const acme = orgs(await detect(text)).find((e) =>
      e.text.startsWith("Acme Inc."),
    );
    expect(acme).toBeDefined();
  });
});

describe("v2 legal-form span discipline — verb trim", () => {
  test("`We retained Smith-Kline LLC` trims back to `Smith-Kline LLC`", async () => {
    // Without the verb trim the walker absorbs `We retained` because
    // it admits any lowercase token. The post-walk verb scan slides
    // the start forward to the first capitalised token following the
    // last sentence-verb indicator.
    const text = "We retained Smith-Kline LLC as counsel.";
    const entities = orgs(await detect(text));
    const hit = entities.find((e) => e.text === "Smith-Kline LLC");
    expect(hit).toBeDefined();
    const overrun = entities.find((e) => e.text.includes("We retained"));
    expect(overrun).toBeUndefined();
  });

  test("prose sentence ending in `příspěvková organizace` is suppressed", async () => {
    // No capitalised token follows the last verb, so the candidate is
    // pure prose and gets dropped rather than swept into a 130-char
    // organisation span.
    const text =
      "Specifikace a přesná poloha místností v areálu střediska je popsána v rozhodnutí, kterým se zařízení převádí na příspěvková organizace.";
    const sweep = orgs(await detect(text)).find((e) => e.text.length > 50);
    expect(sweep).toBeUndefined();
  });
});
