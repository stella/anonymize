import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

// Pipeline context build is CPU-bound; mirror the budget
// used by the other regex-focused suites.
setDefaultTimeout(15_000);

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  enableHotwordRules: false,
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "monetary-suffix-test",
};

let cachedDictionaries: Dictionaries | undefined;
const getDictionaries = async () => {
  if (!cachedDictionaries) {
    cachedDictionaries = await loadTestDictionaries();
  }
  return cachedDictionaries;
};

let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;
const getCtx = () => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const detect = async (text: string) => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText: text,
    config: { ...CONFIG, dictionaries },
    gazetteerEntries: [],
    context: getCtx(),
  });
};

const findMoney = (entities: Awaited<ReturnType<typeof detect>>) =>
  entities.filter((e) => e.label === "monetary amount");

describe("monetary amounts with magnitude suffix", () => {
  test("captures '$25 million' as a single span including the unit", async () => {
    const text = "The deal closed at $25 million in cash.";
    const money = findMoney(await detect(text));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25 million");
  });

  test("captures '$1 billion'", async () => {
    const text = "Termination fee was $1 billion.";
    const money = findMoney(await detect(text));
    expect(money.find((e) => e.text === "$1 billion")).toBeDefined();
  });

  test("captures decimal magnitudes like '$1.5 trillion'", async () => {
    const text = "The fund manages $1.5 trillion in assets.";
    const money = findMoney(await detect(text));
    expect(money.find((e) => e.text === "$1.5 trillion")).toBeDefined();
  });

  test("captures abbreviated forms '$500K' and '$2bn'", async () => {
    const a = findMoney(await detect("Seed round of $500K closed."));
    expect(a.find((e) => e.text === "$500K")).toBeDefined();

    const b = findMoney(await detect("They raised $2bn last quarter."));
    expect(b.find((e) => e.text === "$2bn")).toBeDefined();
  });

  test("captures 'EUR 1.5 billion' (leading code + magnitude)", async () => {
    const money = findMoney(
      await detect("The contract value is EUR 1.5 billion."),
    );
    expect(money.find((e) => e.text === "EUR 1.5 billion")).toBeDefined();
  });

  test("captures '100 million USD' (magnitude between number and code)", async () => {
    const money = findMoney(await detect("Loss provision: 100 million USD."));
    expect(money.find((e) => e.text === "100 million USD")).toBeDefined();
  });

  test("matches uppercase plural forms ('MILLIONS')", async () => {
    // The plural `s` must sit inside the case-insensitive
    // group; otherwise uppercase plurals slip back to
    // the bare-number fallback.
    const money = findMoney(
      await detect("Estimated at $25 MILLIONS worldwide."),
    );
    expect(money.find((e) => e.text === "$25 MILLIONS")).toBeDefined();
  });

  test("'25 people' is not a monetary amount", async () => {
    const money = findMoney(await detect("Around 25 people attended."));
    expect(money).toHaveLength(0);
  });

  test("'$25 grapes' falls back to '$25' (unknown unit word)", async () => {
    const money = findMoney(await detect("She bought $25 grapes at market."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });

  test("preserves comma-grouped form '$1,000,000,000' (no suffix)", async () => {
    const money = findMoney(await detect("Paid $1,000,000,000 at signing."));
    expect(money.find((e) => e.text === "$1,000,000,000")).toBeDefined();
  });

  test("'$25 km' does not consume the unit (km is not a magnitude)", async () => {
    // Defensive: ensure the abbrev branch doesn't gobble
    // 'k' from a non-monetary trailing word.
    const money = findMoney(await detect("Race entry costs $25 km away."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });
});
