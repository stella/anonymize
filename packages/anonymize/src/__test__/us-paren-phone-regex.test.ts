/**
 * Regression tests for the US `(NNN) NNN-NNNN` phone recognizer.
 * `INTL_PHONE` requires a leading `+`; `TEL_PREFIX_PHONE` requires a
 * `tel.:` / `Phone:` label; neither matches the bare parenthesised
 * area-code form that dominates US notice blocks. Test text avoids the
 * `Phone:` / `Tel.` trigger prefixes so the regex fires in isolation.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../legacy";
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
  workspaceId: "us-paren-phone-test",
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

const expectPhone = (entities: Entity[], substring: string): Entity => {
  const hit = entities.find(
    (e) => e.label === "phone number" && e.text.includes(substring),
  );
  expect(hit).toBeDefined();
  return hit!;
};

describe("US paren phone (NNN) NNN-NNNN", () => {
  test("captured in plain prose", async () => {
    const text =
      "The signing officer can be reached at (212) 378-8550 between 9 and 5.";
    const entities = await detect(text);
    expectPhone(entities, "(212) 378-8550");
  });

  test("captured with no space after closing paren", async () => {
    const text =
      "Direct line to outside counsel is (212)701-5800 during business hours.";
    const entities = await detect(text);
    expectPhone(entities, "(212)701-5800");
  });

  test("captured with dot separator after the area code", async () => {
    const text = "Reach the desk at (818) 548.9288 weekdays.";
    const entities = await detect(text);
    expectPhone(entities, "(818) 548.9288");
  });

  test("captured with dash separator right after the closing paren", async () => {
    const text = "Forward calls to (212)-735-3000 during business hours.";
    const entities = await detect(text);
    expectPhone(entities, "(212)-735-3000");
  });

  test("captured with dot separator right after the closing paren", async () => {
    const text = "Reception at (212).735.3000 — please reach out.";
    const entities = await detect(text);
    expectPhone(entities, "(212).735.3000");
  });

  test("multiple paren phones in adjacent lines", async () => {
    const text = [
      "The committee can be reached at (206) 652-3710 or (212) 728-9255.",
      "Backup number is (818) 548-9288.",
    ].join("\n");
    const entities = await detect(text);
    expectPhone(entities, "(206) 652-3710");
    expectPhone(entities, "(212) 728-9255");
    expectPhone(entities, "(818) 548-9288");
  });

  test("paren area code without the dash form is not over-matched", async () => {
    // "(see § 3) 555 1212" looks like a phone if punctuation is too
    // loose. The regex requires the `(NNN)` paren area code shape on
    // the left, so this must not be tagged.
    const text = "See (see § 3) 555 1212 of the regulations.";
    const entities = await detect(text);
    const spurious = entities.find(
      (e) => e.label === "phone number" && e.text.includes("(see"),
    );
    expect(spurious).toBeUndefined();
  });

  test("section reference (NN) does not match without 3-digit area code", async () => {
    // "(42) 555-1234" — wrong area code width must not match.
    const text = "Section (42) 555-1234 references the manual.";
    const entities = await detect(text);
    const spurious = entities.find(
      (e) => e.label === "phone number" && e.text.includes("(42)"),
    );
    expect(spurious).toBeUndefined();
  });
});
