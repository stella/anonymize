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

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";
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
  workspaceId: "toc-orphan-street-test",
};

const detect = async (fullText: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

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
    // Without the `Section` stopword the contract reference
    // would be tagged as an address.
    const text =
      "“Post-Closing Welfare Plans” shall have the meaning set forth in " +
      "Section 6.9(b).";
    const entities = await detect(text);
    const section6 = entities.find(
      (e) => e.label === "address" && e.text === "Section 6",
    );
    expect(section6).toBeUndefined();
  });

  test("real header-zone single-line orphan address still fires", async () => {
    // The fix should not regress the original purpose: a
    // standalone street + number line in the header zone
    // bracketed by other entities still has to be picked
    // up as an address. Pad the document so the address
    // lands inside the top 15% header-zone window.
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
    const orphan = entities.find(
      (e) => e.label === "address" && e.text === "Evropská 710",
    );
    expect(orphan).toBeDefined();
  });
});
