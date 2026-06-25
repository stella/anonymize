import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

// Fresh PipelineContext per file pays the regex-set DFA
// build cost once; 15 s gives CI headroom.
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
  workspaceId: "us-bank-routing-test",
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

const bankAccounts = (entities: Awaited<ReturnType<typeof run>>) =>
  entities.filter((e) => e.label === "bank account number").map((e) => e.text);

// US wire instructions in contract notice blocks label the routing number
// with an "ABA:" / "Routing Number:" cue; 122100024 is a checksum-valid ABA
// number. The recognizer pairs that cue with the us.rtn (MOD-10) checksum, so
// generality lives in the cue + checksum, not in any list of numbers.
describe("US ABA routing number — cue + checksum recognizer", () => {
  test("a checksum-valid routing number after 'ABA:' is a bank account number", async () => {
    expect(
      bankAccounts(await run("Wire to ABA: 122100024 for the transfer.")),
    ).toContain("122100024");
  });

  test("the routing-number cue is case-insensitive", async () => {
    expect(
      bankAccounts(await run("Please use routing number 122100024 today.")),
    ).toContain("122100024");
  });

  // The valid-id check strips separators before validating, so a routing
  // number printed with dashes still passes the checksum.
  test("a dash-separated routing number is captured and validated", async () => {
    expect(
      bankAccounts(await run("Wire to ABA: 1221-0002-4 for the transfer.")),
    ).toContain("1221-0002-4");
  });

  // Invariant 1 — the checksum is mandatory: a cued but checksum-invalid
  // 9-digit number is not emitted (123456789 fails the ABA MOD-10 weights).
  test("a checksum-invalid number after the cue is rejected", async () => {
    expect(
      bankAccounts(await run("Wire to ABA: 123456789 today.")),
    ).not.toContain("123456789");
  });

  // Invariant 2 — the cue is mandatory: a routing-shaped number in ordinary
  // prose, with no ABA/routing cue, is not claimed as a bank account.
  test("a routing-shaped number with no cue is not a bank account number", async () => {
    expect(
      bankAccounts(await run("The reference 122100024 appears in section 5.")),
    ).toHaveLength(0);
  });
});
