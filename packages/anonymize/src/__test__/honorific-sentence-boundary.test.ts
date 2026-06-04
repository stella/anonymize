import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(15_000);

const CONFIG: PipelineConfig = {
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
  workspaceId: "honorific-boundary-test",
};

let cachedDictionaries: Dictionaries | undefined;
let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;
const run = async (text: string) => {
  cachedDictionaries ??= await loadTestDictionaries();
  sharedCtx ??= createPipelineContext();
  return runPipeline({
    fullText: text,
    config: { ...CONFIG, dictionaries: cachedDictionaries },
    gazetteerEntries: [],
    context: sharedCtx,
  });
};

const persons = (entities: Awaited<ReturnType<typeof run>>) =>
  entities.filter((e) => e.label === "person").map((e) => e.text);

// A full-word honorific ("President", "Lord", "Judge") is not an abbreviation,
// so a trailing period ends the sentence and must not be consumed into the
// person span. Abbreviation honorifics ("Mr.", "Sr.", "Messrs.") keep the dot.
describe("honorific person span respects sentence boundaries", () => {
  test("a full-word honorific span stops at a sentence-ending period", async () => {
    const ps = persons(
      await run(
        "appoints Employee as Assistant to the President. The Board met.",
      ),
    );
    // No person span crosses the period into the next sentence.
    expect(ps.some((p) => p.includes("."))).toBe(false);
  });

  test("an abbreviation honorific keeps its dot before the name", async () => {
    expect(persons(await run("We met Mr. John Smith yesterday."))).toContain(
      "Mr. John Smith",
    );
  });

  test("an abbreviation honorific without a dot (British style) still matches", async () => {
    expect(persons(await run("We met Mr John Smith yesterday."))).toContain(
      "Mr John Smith",
    );
  });

  test("a Spanish abbreviation honorific (Sr.) keeps its dot", async () => {
    expect(persons(await run("Sr. Alfonso García signed the deed."))).toContain(
      "Sr. Alfonso García",
    );
  });

  test("a full-word honorific followed by a name still matches", async () => {
    expect(
      persons(
        await run(
          "President George Washington and Lord Peter Davidson attended.",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "President George Washington",
        "Lord Peter Davidson",
      ]),
    );
  });
});
