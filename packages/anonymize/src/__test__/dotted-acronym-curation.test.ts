/**
 * Regression test for the dotted-acronym deny-list curation.
 *
 * A handful of curated dictionaries (courts, hospitals,
 * banks, insurance, universities) carry short
 * dotted-acronym entries such as `S.C.`, `D.D.C.`,
 * `H.M.G.`. The Aho-Corasick search runs case-insensitive
 * on token boundaries, and because `.` is not a word
 * character, those entries match inside any longer dotted
 * citation that ends in the same letters — for example,
 * `S.C.` inside the U.S. Code citation `U.S.C.`. The
 * match-time filter skips curated entries with this shape
 * only when they are the suffix of a longer dotted token,
 * so standalone official aliases still redact.
 *
 * Custom (caller-supplied) deny-list terms stay exact so
 * a user can deliberately redact such a token if needed.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(60_000);

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
  threshold: 0.3,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  enableHotwordRules: false,
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "dotted-acronym-curation-test",
};

let cached: Dictionaries | undefined;
const getDictionaries = async (): Promise<Dictionaries> => {
  if (!cached) cached = await loadTestDictionaries();
  return cached;
};

let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;
const getCtx = () => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const detect = async (text: string, override?: Partial<PipelineConfig>) => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText: text,
    config: { ...baseConfig, dictionaries, ...override },
    gazetteerEntries: [],
    context: getCtx(),
  });
};

describe("dotted-acronym deny-list curation", () => {
  test("legal-code citations are not tagged as organizations", async () => {
    // `S.C.` is a curated hospital-acronym entry that
    // would otherwise match inside the U.S. Code
    // citation. Once filtered, the deny list emits no
    // entity for the citation body.
    const text =
      "violated Section 10(b) of the Exchange Act [15 U.S.C. § 78j(b)]";
    const entities = await detect(text);
    const orgs = entities.filter(
      (e) => e.label === "organization" && /U\.S\.C\./.test(e.text),
    );
    expect(orgs).toEqual([]);
  });

  test("dotted state abbreviations inside place names are not flagged", async () => {
    // `D.C.` is a recurrent curated abbreviation; the
    // filter prevents collisions with `Washington D.C.`
    // and similar place-name forms in English prose.
    const text = "filed in the District of Washington D.C., per Rule 9.";
    const entities = await detect(text);
    const acronymHits = entities.filter((e) => /D\.C\./.test(e.text));
    // No deny-list hit anchored on the bare `D.C.` token.
    expect(acronymHits.every((e) => e.text.length > 4)).toBe(true);
  });

  test("custom caller-supplied dotted entries are still respected", async () => {
    // The filter only applies to curated dictionaries.
    // A caller who explicitly opts in via `customDenyList`
    // can still redact such a token (synthetic example:
    // an internal team alias).
    const text = "Memo from Q.A. to the audit committee.";
    const entities = await detect(text, {
      customDenyList: [{ value: "Q.A.", label: "organization" }],
    });
    const qa = entities.find(
      (e) => e.label === "organization" && e.text === "Q.A.",
    );
    expect(qa).toBeDefined();
  });

  test("custom duplicates do not disable curated suffix filtering", async () => {
    const text = "The citation E.D.N.J. remains public.";
    const entities = await detect(text, {
      customDenyList: [{ value: "D.N.J.", label: "person" }],
    });
    const customHit = entities.find(
      (e) => e.label === "person" && e.text === "D.N.J.",
    );
    const curatedHit = entities.find(
      (e) => e.label === "organization" && e.text === "D.N.J.",
    );
    expect(customHit).toBeDefined();
    expect(curatedHit).toBeUndefined();
  });

  test("curated dotted city aliases are preserved as addresses", async () => {
    // Dotted place aliases such as `L.A.` are address data,
    // not the noisy court/bank/hospital acronym class. Keep
    // them available for address redaction while filtering
    // non-address dictionary collisions like `S.C.`.
    const entities = await detect("The notice was sent to L.A.");
    const city = entities.find(
      (e) => e.label === "address" && e.text === "L.A.",
    );
    expect(city).toBeDefined();
  });

  test("standalone dotted organization aliases are preserved", async () => {
    const courtEntities = await detect("The case was filed in D.N.J.");
    const court = courtEntities.find(
      (e) => e.label === "organization" && e.text === "D.N.J.",
    );
    expect(court).toBeDefined();

    const bankEntities = await detect("The account was held at C.E.C.");
    const bank = bankEntities.find(
      (e) => e.label === "organization" && e.text === "C.E.C.",
    );
    expect(bank).toBeDefined();
  });
});
