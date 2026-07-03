/**
 * Regression tests for the header-zone orphan-street and
 * bare-house-number heuristics in `confidence-boost`.
 *
 * - The orphan-street pattern must require a single-line
 *   `[Uppercase word(s)] [number]`. A table-of-contents
 *   block where the title and the page number sit on
 *   separate lines must not match.
 * - The bare-house-number pattern must reject contract
 *   navigation words such as `Section 6` even when a real
 *   address span sits nearby.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const config: PipelineConfig = {
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
  workspaceId: "toc-orphan-street-test",
  dictionaries,
};

const detect = (fullText: string): Promise<NativePipelineEntity[]> =>
  detectNative(config, fullText);

describe("TOC + orphan-street guardrails", () => {
  test("TOC entries with title and page number on separate lines are not addresses", async () => {
    // Layout mirrors a contract table of contents — the
    // header sits on its own line, then a blank gap, then
    // the page number on a separate line. The orphan-street
    // pattern must NOT pretend `Litigation\n  \n26` is a
    // street + house number address.
    const toc =
      "TABLE OF CONTENTS\n\nSection 4.10\n \nNo Undisclosed Liabilities\n  \n \n26\n \n" +
      "Section 4.11\n \nLitigation\n  \n \n26\n \nSection 4.12\n \nEmployee Benefit Plans\n  \n \n26\n";
    const entities = await detect(toc);
    const tocAddresses = entities.filter(
      (e) =>
        e.label === "address" &&
        (e.text.includes("Litigation") ||
          e.text.includes("Liabilities") ||
          e.text.includes("Employee Benefit Plans")),
    );
    expect(tocAddresses).toEqual([]);
  });

  test("`Section <N>` near an address span is not promoted to an address", async () => {
    // The bare-house-number scan looks for `<Uppercase> <number>`
    // within 50 chars of a confirmed address on the same line.
    // We seed a confirmed address (`PSČ 160 00`) so the
    // near-address branch actually runs; without the `Section`
    // stopword the contract reference would be tagged as an
    // address. Removing `Section` from `BARE_STOPWORDS`
    // produces an `address` entity with text `Section 6`,
    // which is what this test guards against.
    const text = "PSČ 160 00. Section 6 is referenced.";
    const entities = await detect(text);
    // Sanity-check that the anchor address is detected so the
    // near-address branch actually runs.
    const anchor = entities.find(
      (e) => e.label === "address" && e.text.includes("160"),
    );
    expect(anchor).toBeDefined();
    const sectionAddr = entities.find(
      (e) => e.label === "address" && e.text === "Section 6",
    );
    expect(sectionAddr).toBeUndefined();
  });

  test("structural part labels near an address span are not promoted to addresses", async () => {
    const text = "PSČ 160 00. Attachment 2 and Part 4 are referenced.";
    const entities = await detect(text);
    const structuralAddresses = entities.filter(
      (e) =>
        e.label === "address" &&
        (e.text === "Attachment 2" || e.text === "Part 4"),
    );
    expect(structuralAddresses).toEqual([]);
  });

  test("real header-zone single-line orphan address still fires", async () => {
    // The fix should not regress the original purpose: a
    // standalone street + number line in the header zone
    // bracketed by other entities still has to be picked
    // up as an address. With multi-line notice-block support,
    // the street line and the city/zip line below it are
    // joined into one span, but the street component must
    // still appear somewhere inside the emitted address.
    // Pad the document so the address lands inside the top
    // 15% header-zone window.
    const tail =
      "\n\nPlatba: bezhotovostně.\n" +
      "Smluvní strany berou na vědomí veškeré podmínky.\n".repeat(40);
    const text =
      "Smluvní strany:\n\n" +
      "Společnost: Acme s.r.o.\n" +
      "Evropská 710\n" +
      "Praha 6, PSČ 160 00\n" +
      tail;
    const entities = await detect(text);
    const address = entities.find(
      (e) => e.label === "address" && e.text.includes("Evropská 710"),
    );
    expect(address).toBeDefined();
  });
});
