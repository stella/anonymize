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
  workspaceId: "labeled-phone-test",
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

const phones = (entities: Awaited<ReturnType<typeof run>>) =>
  entities.filter((e) => e.label === "phone number").map((e) => e.text);

// Contract notice blocks label fax/telecopy/telephone numbers; US numbers are
// commonly written without parentheses ("Fax 702-657-1411") and international
// numbers use "+CC" grouping ("+86-138-2319-3216"). A telephony cue plus a
// multi-group number shape is the recognizer; the cue is mandatory.
describe("labeled phone / fax / telecopy numbers", () => {
  test("a 'Telecopy:'-labeled number is a phone number", async () => {
    expect(
      phones(await run("Attn: A. Superfisky Telecopy: 415-796-1165")),
    ).toContain("415-796-1165");
  });

  test("a 'Fax'-labeled number without parentheses is detected", async () => {
    expect(phones(await run("Tel: 702-657-1500; Fax 702-657-1411"))).toContain(
      "702-657-1411",
    );
  });

  test("a '+CC' grouped international number after a phone cue is detected", async () => {
    expect(
      phones(
        await run("Contact phone number: +86-138-2319-3216 and the seller"),
      ),
    ).toContain("+86-138-2319-3216");
  });

  test("a 'Facsimile:'-labeled number is a phone number", async () => {
    expect(phones(await run("Facsimile: 212-555-0142"))).toContain(
      "212-555-0142",
    );
  });

  // Invariant — the cue is mandatory: number-shaped ranges in ordinary prose
  // (fiscal-year and section ranges) are not phone numbers without a cue.
  test("digit ranges with no telephony cue are not phone numbers", async () => {
    expect(
      phones(await run("fiscal years 2018-2019 and sections 100-200 herein")),
    ).toHaveLength(0);
  });

  // Invariant — a cue word with no following number does not emit.
  test("a phone cue with no number does not emit", async () => {
    expect(
      phones(await run("Please send a fax to the registered office.")),
    ).toHaveLength(0);
  });

  // Invariant — a real phone has >=3 digit groups, so a two-group numeric
  // range right after a verb-used cue ("Please fax 2018-2019") is not a phone.
  // This keeps year/section/page ranges from being redacted as phone numbers.
  test("a verb-used cue followed by a two-group range is not a phone", async () => {
    expect(phones(await run("Please fax 2018-2019 tax returns"))).toHaveLength(
      0,
    );
    expect(phones(await run("fax 100-200 pages to the office"))).toHaveLength(
      0,
    );
  });
});
