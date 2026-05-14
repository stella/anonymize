/**
 * Twitter / X Holdings merger agreement — explicit FP/FN
 * regression cases.
 *
 * Each test is `test.skip(...)` until the corresponding
 * detector fix lands. When fixing a case, flip `skip` to
 * regular `test` and run the suite. See the human-readable
 * ledger at `./twitter-regression-ledger.md` for context and
 * suspected root causes.
 *
 * Cases are numbered `anon-1NN` (false positives) and
 * `anon-2NN` (false negatives) for cross-reference with
 * GitHub issue/PR titles.
 *
 * Run: `bun test packages/anonymize/src/__test__/slow/`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../../index";
import type { Entity, PipelineConfig } from "../../types";
import { loadTestDictionaries } from "../load-dictionaries";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "fixtures",
  "contracts",
  "en",
  "twitter-merger-agreement.txt",
);

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
  workspaceId: "twitter-regression-test",
};

// One pipeline run per worker, shared across every case.
let cached: Promise<Entity[]> | null = null;
const getEntities = async (): Promise<Entity[]> => {
  if (cached) return cached;
  cached = (async () => {
    const fullText = readFileSync(FIXTURE_PATH, "utf8");
    const dictionaries = await loadTestDictionaries();
    const context = createPipelineContext();
    return runPipeline({
      fullText,
      config: { ...CONFIG, dictionaries },
      gazetteerEntries: [],
      context,
    });
  })();
  return cached;
};

const hasEntity = (
  entities: readonly Entity[],
  predicate: (e: Entity) => boolean,
): boolean => entities.some(predicate);

const exact = (label: string, text: string) => (e: Entity) =>
  e.label === label && e.text === text;

// Collapse any whitespace run (incl. nbsp  ) to a single space.
// Several SEC counsel/firm spans in the fixture contain nbsp; without
// this, a plain-space target would not match an nbsp-bearing emission
// and a still-present false positive could pass silently.
const normWs = (s: string) => s.replace(/\s+/g, " ");

const exactNormWs = (label: string, text: string) => (e: Entity) =>
  e.label === label && normWs(e.text) === normWs(text);

describe("twitter merger — false positives (regression)", () => {
  // ── deny-list: generic legal/role terms tagged as person ────

  test.skip('TODO(anon-101): false positive — "Laws" tagged as person', async () => {
    // Context: "...any Antitrust Laws or Blue Sky Laws..."
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Laws"))).toBe(false);
  });

  test.skip('TODO(anon-102): false positive — "Blue Sky Laws" tagged as person', async () => {
    // Context: "any applicable foreign or state Blue Sky Laws"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Blue Sky Laws"))).toBe(false);
  });

  test.skip('TODO(anon-103): false positive — "Bond Hedge Documentation" tagged as person', async () => {
    // Context: defined term in Article I.
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("person", "Bond Hedge Documentation")),
    ).toBe(false);
  });

  test.skip('TODO(anon-104): false positive — "Bond Hedge Transactions" tagged as person', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("person", "Bond Hedge Transactions")),
    ).toBe(false);
  });

  test.skip('TODO(anon-105): false positive — "Vote" tagged as person', async () => {
    // Context: "Company Stockholder Advisory Vote"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Vote"))).toBe(false);
  });

  test.skip('TODO(anon-106): false positive — "Measures" tagged as person', async () => {
    // Context: "COVID-19 Measures"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Measures"))).toBe(false);
  });

  test.skip('TODO(anon-107): false positive — "Letters" tagged as person', async () => {
    // Context: "Debt Commitment Letters"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Letters"))).toBe(false);
  });

  test.skip('TODO(anon-108): false positive — bare "Morgan" tagged as person', async () => {
    // Context: should fold into "J.P. Morgan Securities LLC"
    // or "Morgan Stanley", not stand alone.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Morgan"))).toBe(false);
  });

  test.skip('TODO(anon-109): false positive — "Fee" tagged as person', async () => {
    // Context: "Termination Fee" / "Parent Termination Fee"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Fee"))).toBe(false);
  });

  test.skip('TODO(anon-110): false positive — "Tesla Shares" tagged as person', async () => {
    // Defined term referencing Tesla, Inc. common stock —
    // a financial-instrument label, not a person.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Tesla Shares"))).toBe(false);
  });

  test.skip('TODO(anon-111): false positive — "Master Confirmation" tagged as person', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Master Confirmation"))).toBe(
      false,
    );
  });

  test.skip('TODO(anon-112): false positive — "London Branch" tagged as person', async () => {
    // Branch suffix of "JPMorgan Chase Bank, N.A., London Branch"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "London Branch"))).toBe(false);
  });

  test.skip('TODO(anon-113): false positive — "Bond Hedging Transactions" (variant) tagged as person', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("person", "Bond Hedging Transactions")),
    ).toBe(false);
  });

  test.skip('TODO(anon-114): false positive — "Hart-Scott-Rodino Antitrust Improvements" tagged as person', async () => {
    // Statute name (HSR Act). Should not be a person.
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("person", "Hart-Scott-Rodino Antitrust Improvements"),
      ),
    ).toBe(false);
  });

  test.skip('TODO(anon-115): false positive — "Labor Matters" tagged as person', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Labor Matters"))).toBe(false);
  });

  test.skip('TODO(anon-116): false positive — "Vote Required" tagged as person', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Vote Required"))).toBe(false);
  });

  test.skip('TODO(anon-117): false positive — "Accounting Standards Board" tagged as person', async () => {
    // Body name (FASB). Should be organization at most.
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("person", "Accounting Standards Board")),
    ).toBe(false);
  });

  test.skip('TODO(anon-118): false positive — "Merrill Lynch" tagged as person', async () => {
    // Should fold into "Bank of America Merrill Lynch" as
    // a single organization span.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Merrill Lynch"))).toBe(false);
  });

  test.skip('TODO(anon-119): false positive — "Wall Street Journal" tagged as person', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Wall Street Journal"))).toBe(
      false,
    );
  });

  test.skip("TODO(anon-120): false positive — entity span includes trailing curly close-quote", async () => {
    // e.g. `Bond Hedge Documentation”`, `Tesla Shares”`.
    const entities = await getEntities();
    expect(entities.some((e) => /[”"]$/.test(e.text))).toBe(false);
  });

  // ── deny-list: bare bank/oil token ────────────────────────

  test.skip('TODO(anon-121): false positive — bare "Bank" tagged as organization', async () => {
    // 20+ occurrences. Should require a qualifier like
    // "Wells Fargo Bank, N.A." for the full span to fire.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("organization", "Bank"))).toBe(false);
  });

  test.skip('TODO(anon-122): false positive — bare "Oil" tagged as organization', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("organization", "Oil"))).toBe(false);
  });

  // ── deny-list / hotword: location nouns mistagged as address ─

  test.skip('TODO(anon-123): false positive — bare "Delaware" tagged as address', async () => {
    // Context: "a Delaware corporation" (corporate-formation
    // phrase, not a postal address).
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Delaware"))).toBe(false);
  });

  test.skip('TODO(anon-124): false positive — bare "New York" tagged as address', async () => {
    // Standalone state name from a governing-law clause.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "New York"))).toBe(false);
  });

  test.skip('TODO(anon-125): false positive — "California Corporations" tagged as address', async () => {
    // Fragment of "California Corporations Code".
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("address", "California Corporations")),
    ).toBe(false);
  });

  test.skip('TODO(anon-126): false positive — "Pacific Time" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Pacific Time"))).toBe(false);
  });

  test.skip('TODO(anon-127): false positive — "Silver Lake Partners" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Silver Lake Partners"))).toBe(
      false,
    );
  });

  test.skip('TODO(anon-128): false positive — "Silver Lake Investment" tagged as address', async () => {
    // Defined-term fragment of "Silver Lake Investment Agreement"
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("address", "Silver Lake Investment")),
    ).toBe(false);
  });

  test.skip('TODO(anon-129): false positive — "New York Stock" tagged as address', async () => {
    // Truncation of "New York Stock Exchange"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "New York Stock"))).toBe(false);
  });

  test.skip('TODO(anon-130): false positive — 5-char fragment "The D" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "The D"))).toBe(false);
  });

  test.skip('TODO(anon-131): false positive — first name "Anthony" tagged as address', async () => {
    // Should be person, span "Anthony F. Vernace"
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Anthony"))).toBe(false);
  });

  test.skip('TODO(anon-132): false positive — first name "Katherine" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Katherine"))).toBe(false);
  });

  test.skip('TODO(anon-133): false positive — bare "Palo Alto" emitted as standalone address span', async () => {
    // Should be merged into the full notice-block address span.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Palo Alto"))).toBe(false);
  });

  test.skip('TODO(anon-134): false positive — "Delaware Court" tagged as address', async () => {
    // The Delaware Court of Chancery is a court, not a
    // postal address.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Delaware Court"))).toBe(false);
  });

  test.skip("TODO(anon-135): false positive — trigger expansion swallows a full governing-law clause", async () => {
    // Span starts at "State of Delaware or any other
    // jurisdiction)" and runs ~159 chars into the clause.
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.startsWith("State of Delaware") &&
          e.text.length > 40,
      ),
    ).toBe(false);
  });

  test.skip("TODO(anon-136): false positive — forum-selection clause captured as address", async () => {
    // Same root cause as anon-135; pin the second-clause variant.
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.includes("federal court sitting in the State of Delaware"),
      ),
    ).toBe(false);
  });

  test.skip('TODO(anon-137): false positive — "District of New York sitting in New York County" tagged as address', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("address", "District of New York sitting in New York County"),
      ),
    ).toBe(false);
  });

  test.skip('TODO(anon-138): false positive — bare "State of New York" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "State of New York"))).toBe(
      false,
    );
  });

  test.skip("TODO(anon-139): false positive — entity span includes trailing period", async () => {
    // e.g. `State of Delaware.` — trim should drop the dot.
    const entities = await getEntities();
    expect(
      entities.some((e) => /\.$/.test(e.text) && e.label === "address"),
    ).toBe(false);
  });

  // ── deny-list: court tagged as organization ───────────────

  test.skip('TODO(anon-140): false positive — bare "Supreme Court" tagged as organization', async () => {
    // Either the span should include the jurisdiction
    // ("Supreme Court of the State of New York") or it
    // should not be emitted as a bare two-word entity.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("organization", "Supreme Court"))).toBe(
      false,
    );
  });

  // ── address-seeds: TOC page numbers swept into address ────

  test.skip('TODO(anon-141): false positive — TOC entry "The Merger 13" tagged as address', async () => {
    // Address-seeds postal-code clustering treats the
    // trailing page number as a postal seed.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "The Merger 13"))).toBe(false);
  });

  test('TODO(anon-142): false positive — "Section 6" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Section 6"))).toBe(false);
  });

  test('TODO(anon-143): false positive — "Section 8" tagged as address', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Section 8"))).toBe(false);
  });

  test.skip('TODO(anon-144): false positive — "Suite 900" emitted as standalone address', async () => {
    // Should be merged into the full notice-block span,
    // not stand alone.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("address", "Suite 900"))).toBe(false);
  });

  // ── coreference / span hygiene: name fragments as person ───

  test.skip('TODO(anon-145): false positive — "Market Street" tagged as person', async () => {
    // Should be part of the "1355 Market Street" address.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Market Street"))).toBe(false);
  });

  test.skip('TODO(anon-146): false positive — "Meagher & Flom LLP" tagged as person', async () => {
    // Fragment of "Skadden, Arps, Slate, Meagher & Flom LLP".
    // Fixture contains an nbsp variant; normalize whitespace so an
    // nbsp-bearing FP cannot pass silently against a plain-space target.
    const entities = await getEntities();
    expect(
      hasEntity(entities, exactNormWs("person", "Meagher & Flom LLP")),
    ).toBe(false);
  });

  test.skip('TODO(anon-147): false positive — "Wilson Sonsini Goodrich & Rosati" tagged as person', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exactNormWs("person", "Wilson Sonsini Goodrich & Rosati"),
      ),
    ).toBe(false);
  });

  test.skip('TODO(anon-148): false positive — "Simpson Thacher & Bartlett LLP" tagged as person', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exactNormWs("person", "Simpson Thacher & Bartlett LLP"),
      ),
    ).toBe(false);
  });

  test.skip('TODO(anon-149): false positive — surname-only "Kim" tagged as person', async () => {
    // Should be folded into "Dohyun Kim".
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Kim"))).toBe(false);
  });

  test.skip('TODO(anon-150): false positive — surname-only "Segal" tagged as person', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Segal"))).toBe(false);
  });

  test.skip('TODO(anon-151): false positive — "Road" tagged as person', async () => {
    // Should be part of "650 Page Mill Road" address.
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Road"))).toBe(false);
  });

  test.skip('TODO(anon-152): false positive — "M. Krause" tagged as person', async () => {
    // Should be "Katherine M. Krause" (single span).
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "M. Krause"))).toBe(false);
  });

  test.skip("TODO(anon-153): false positive — corporate-formation phrase as address", async () => {
    // Either span should be "Delaware corporation"
    // (labeled as legal-form annotation) or not emitted.
    const entities = await getEntities();
    const offending = entities.filter(
      (e) => e.label === "address" && e.text === "Delaware",
    );
    expect(offending).toHaveLength(0);
  });
});

describe("twitter merger — false negatives (regression)", () => {
  // ── missing party names ───────────────────────────────────

  test.skip('TODO(anon-201): false negative — "X Holdings I, Inc." not consistently tagged as organization', async () => {
    // Context: preamble "is made by and among Twitter,
    // Inc.,..., X Holdings I, Inc., a Delaware corporation..."
    // Pin the specific preamble occurrence (offset < 500) so a
    // late-document mention does not silently satisfy the assertion.
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "organization" &&
          e.text === "X Holdings I, Inc." &&
          e.start < 500,
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-202): false negative — "Twitter, Inc." not tagged as organization', async () => {
    // Context: preamble + signature page + recitals (20+ refs).
    const entities = await getEntities();
    expect(hasEntity(entities, exact("organization", "Twitter, Inc."))).toBe(
      true,
    );
  });

  test.skip('TODO(anon-203): false negative — coreferent "Twitter" not linked to organization', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        (e) => e.label === "organization" && e.text === "Twitter",
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-204): false negative — "Computershare Trust Company, N.A." not detected', async () => {
    // Context: rights agent / paying agent in Section 3
    // and in the Rights Agreement amendment.
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("organization", "Computershare Trust Company, N.A."),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-205): false negative — "Silver Lake Partners V DE (AIV), L.P." not detected', async () => {
    // Context: "Silver Lake Investment Agreement... among
    // Twitter, Inc. and Silver Lake Partners V DE (AIV), L.P."
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("organization", "Silver Lake Partners V DE (AIV), L.P."),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-206): false negative — "Skadden, Arps, Slate, Meagher & Flom LLP" full firm name not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exactNormWs("organization", "Skadden, Arps, Slate, Meagher & Flom LLP"),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-207): false negative — "Morgan Stanley Senior Funding, Inc." not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("organization", "Morgan Stanley Senior Funding, Inc."),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-208): false negative — "Goldman Sachs & Co. LLC" full span not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("organization", "Goldman Sachs & Co. LLC")),
    ).toBe(true);
  });

  test.skip('TODO(anon-209): false negative — "J.P. Morgan Securities LLC" full span not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("organization", "J.P. Morgan Securities LLC")),
    ).toBe(true);
  });

  test.skip('TODO(anon-210): false negative — "Allen & Company LLC" not consistently propagated to follow-on references', async () => {
    const entities = await getEntities();
    const hits = entities.filter(
      (e) => e.label === "organization" && e.text === "Allen & Company LLC",
    );
    // Appears in 4.21 brokers clause + 4.22 advisors clause.
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test.skip('TODO(anon-211): false negative — "Wells Fargo Bank, National Association" full span not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("organization", "Wells Fargo Bank, National Association"),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-212): false negative — "Barclays Bank PLC" full span not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("organization", "Barclays Bank PLC")),
    ).toBe(true);
  });

  test.skip('TODO(anon-213): false negative — "JPMorgan Chase Bank, N.A." full span not detected', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("organization", "JPMorgan Chase Bank, N.A.")),
    ).toBe(true);
  });

  test('TODO(anon-214): false negative — bare "Barclays" not detected as organization', async () => {
    // Context: section 5.6 brokers.
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        (e) => e.label === "organization" && e.text === "Barclays",
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-215): false negative — "Bank of America Merrill Lynch" not a single span', async () => {
    const entities = await getEntities();
    expect(
      hasEntity(
        entities,
        exact("organization", "Bank of America Merrill Lynch"),
      ),
    ).toBe(true);
  });

  // ── address blocks lost or truncated ──────────────────────

  test.skip("TODO(anon-216): false negative — Skadden notice block address truncated", async () => {
    // Expected: a single address span that includes the
    // street number, suite, city, state, and ZIP.
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.includes("525 University Ave") &&
          e.text.includes("Palo Alto") &&
          e.text.includes("94301"),
      ),
    ).toBe(true);
  });

  test.skip("TODO(anon-217): false negative — Twitter HQ address truncated", async () => {
    // 1355 Market Street, Suite 900, San Francisco, CA 94103
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.includes("1355 Market Street") &&
          e.text.includes("94103"),
      ),
    ).toBe(true);
  });

  test.skip("TODO(anon-218): false negative — Wilson Sonsini address truncated", async () => {
    // 650 Page Mill Road, Palo Alto, CA 94304-1050
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.includes("650 Page Mill Road") &&
          e.text.includes("94304"),
      ),
    ).toBe(true);
  });

  test.skip("TODO(anon-219): false negative — Simpson Thacher address truncated", async () => {
    // 425 Lexington Avenue, New York, NY 10017
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "address" &&
          e.text.includes("425 Lexington Avenue") &&
          e.text.includes("10017"),
      ),
    ).toBe(true);
  });

  test.skip("TODO(anon-220): false negative — U.S. ZIP codes not detected as standalone signals", async () => {
    // At minimum one of the four notice-block ZIPs should
    // produce an address-bearing entity.
    const entities = await getEntities();
    const zips = ["94301", "94103", "94304-1050", "10017"];
    expect(
      zips.some((zip) =>
        entities.some((e) => e.label === "address" && e.text.includes(zip)),
      ),
    ).toBe(true);
  });

  // ── monetary / percentage / financial ─────────────────────

  test.skip('TODO(anon-221): false negative — "3.875%" rate on 2027 Senior Notes not detected', async () => {
    const entities = await getEntities();
    expect(entities.some((e) => /^3\.875%/.test(e.text))).toBe(true);
  });

  test.skip('TODO(anon-222): false negative — "5.000%" rate on 2030 Senior Notes not detected', async () => {
    const entities = await getEntities();
    expect(entities.some((e) => /^5\.000%/.test(e.text))).toBe(true);
  });

  test.skip("TODO(anon-223): false negative — convertible-note coupon rates (0.25%, 0.375%, 0%) not detected", async () => {
    const entities = await getEntities();
    const rates = ["0.25%", "0.375%", "0%"];
    expect(rates.every((r) => entities.some((e) => e.text === r))).toBe(true);
  });

  test.skip('TODO(anon-224): false negative — note maturity years ("due 2027" etc.) not detected', async () => {
    // Whether bare years are PII is debatable, but the
    // due-year tag uniquely identifies a security series.
    const entities = await getEntities();
    expect(
      entities.some((e) => e.label === "date" && /due 20\d{2}/.test(e.text)),
    ).toBe(true);
  });

  test.skip('TODO(anon-225): false negative — monetary span "$25 million" truncated to "$25"', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("monetary amount", "$25 million"))).toBe(
      true,
    );
  });

  test.skip("TODO(anon-227): false negative — comma-grouped share counts not detected", async () => {
    // 5,000,000,000 authorised shares + 763,577,530
    // outstanding shares.
    const entities = await getEntities();
    expect(
      ["5,000,000,000", "763,577,530"].every((v) =>
        entities.some((e) => e.text === v && e.label !== "date"),
      ),
    ).toBe(true);
  });

  // ── dates and date coreference ────────────────────────────

  test.skip('TODO(anon-228): false negative — "the date first written above" not coreferenced to April 25, 2022', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "date" && /the date first written above/i.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-229): false negative — "the date hereof" not coreferenced to a date entity', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) => e.label === "date" && /the date hereof/i.test(e.text),
      ),
    ).toBe(true);
  });

  // ── missing people / signatories ──────────────────────────

  test.skip('TODO(anon-230): false negative — "Dohyun Kim" full name not detected', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Dohyun Kim"))).toBe(true);
  });

  test.skip('TODO(anon-231): false negative — "Anthony F. Vernace" full name not detected', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Anthony F. Vernace"))).toBe(
      true,
    );
  });

  test.skip('TODO(anon-232): false negative — "Katherine M. Krause" full name not detected as a single span', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Katherine M. Krause"))).toBe(
      true,
    );
  });

  test.skip('TODO(anon-233): false negative — "Remi P. Korenblit" not detected', async () => {
    const entities = await getEntities();
    expect(hasEntity(entities, exact("person", "Remi P. Korenblit"))).toBe(
      true,
    );
  });

  test.skip("TODO(anon-234): false negative — Twitter executive names referenced in body not detected", async () => {
    // Deferred-ish: most exec names live in disclosure
    // schedules, not the agreement body.
    const entities = await getEntities();
    expect(
      entities.some(
        (e) => e.label === "person" && /(Parag Agrawal|Ned Segal)/.test(e.text),
      ),
    ).toBe(true);
  });

  // ── defined-term coreference ──────────────────────────────

  test.skip('TODO(anon-235): false negative — "the Company" not coreferenced to Twitter, Inc.', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) => e.label === "organization" && /the Company/i.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-236): false negative — "Parent" not coreferenced to X Holdings I, Inc.', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "organization" && /^(?:Parent|the Parent)$/.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-237): false negative — "Acquisition Sub" not coreferenced to X Holdings II, Inc.', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) => e.label === "organization" && /^Acquisition Sub$/.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-238): false negative — "the Equity Investor" not coreferenced to Elon R. Musk', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) => e.label === "person" && /the Equity Investor/i.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip('TODO(anon-239): false negative — "Surviving Corporation" not coreferenced', async () => {
    const entities = await getEntities();
    expect(
      entities.some(
        (e) =>
          e.label === "organization" &&
          /Surviving (Corporation|Company)/i.test(e.text),
      ),
    ).toBe(true);
  });

  test.skip("TODO(anon-240): false negative — agent aliases (Paying Agent, Rights Agent, Margin Loan Borrower) not coreferenced", async () => {
    const entities = await getEntities();
    const aliases = ["Paying Agent", "Rights Agent", "Margin Loan Borrower"];
    expect(
      aliases.every((alias) =>
        entities.some((e) => e.label === "organization" && e.text === alias),
      ),
    ).toBe(true);
  });

  // ── span hygiene ───────────────────────────────────────────

  test.skip("TODO(anon-241): false negative — span hygiene: trailing curly close-quote not trimmed", async () => {
    // Already covered as a positive assertion in anon-120;
    // pinning here as the inverse formulation (no span
    // should retain a typographic quote).
    const entities = await getEntities();
    expect(
      entities.every((e) => !e.text.endsWith("”") && !e.text.endsWith('"')),
    ).toBe(true);
  });

  test('TODO(anon-242): false negative — "World Health Organization" boundary stable across releases', async () => {
    // Pin the current pass to catch regressions if a
    // detector tweak truncates the span.
    const entities = await getEntities();
    expect(
      hasEntity(entities, exact("organization", "World Health Organization")),
    ).toBe(true);
  });
});
