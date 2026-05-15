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

  test("captures hundred-scale suffixes from language data", async () => {
    const money = findMoney(await detect("Escrow holdback was $25 hundred."));
    expect(money.find((e) => e.text === "$25 hundred")).toBeDefined();
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

  test("captures '$25 million USD' with the leading symbol", async () => {
    const money = findMoney(await detect("Purchase price: $25 million USD."));
    expect(money.find((e) => e.text === "$25 million USD")).toBeDefined();
    expect(money.find((e) => e.text === "25 million USD")).toBeUndefined();
  });

  test("does not treat stock quantities as monetary amounts", async () => {
    const money = findMoney(
      await detect("The fund bought 100 million AMD shares yesterday."),
    );
    expect(money).toHaveLength(0);
  });

  test("does not treat modified stock quantities as monetary amounts", async () => {
    const money = findMoney(
      await detect(
        "The fund bought 100 million AMD ordinary shares yesterday.",
      ),
    );
    expect(money).toHaveLength(0);
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

  test("'$25 m cable' is not extended (lowercase m = metre, not million)", async () => {
    // Single-letter K/M are case-sensitive: lowercase
    // `m` after a price is overwhelmingly metres, not
    // million ("$25 m cable", "$10 m above sea level").
    // Finance/journalism shorthand always capitalises.
    const money = findMoney(await detect("Need a $25 m cable for the rig."));
    expect(money).toHaveLength(1);
    expect(money[0]!.text).toBe("$25");
  });

  test("short PT-BR abbreviations do not apply globally", async () => {
    const distance = findMoney(await detect("The hotel is $25 mi away."));
    expect(distance).toHaveLength(1);
    expect(distance[0]!.text).toBe("$25");

    const schedule = findMoney(
      await detect("The service costs $10 bi-weekly."),
    );
    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.text).toBe("$10");
  });

  test("ambiguous multilingual suffixes do not apply globally", async () => {
    const setAside = findMoney(await detect("We paid $25 set aside for fees."));
    expect(setAside).toHaveLength(1);
    expect(setAside[0]!.text).toBe("$25");

    const film = findMoney(
      await detect("The order includes $25 mil spec film."),
    );
    expect(film).toHaveLength(1);
    expect(film[0]!.text).toBe("$25");
  });

  test("share-quantity guard keeps ordinary English nouns", async () => {
    const money = findMoney(
      await detect("The estimate lists 100 USD parts and 50 USD labor."),
    );
    expect(money.map((entity) => entity.text)).toEqual(
      expect.arrayContaining(["100 USD", "50 USD"]),
    );
  });

  test("'$25M' uppercase abbreviation still captures as million", async () => {
    const money = findMoney(await detect("Round closed at $25M."));
    expect(money.find((e) => e.text === "$25M")).toBeDefined();
  });
});
