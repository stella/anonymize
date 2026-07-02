import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createPipelineContext, redactText, runPipeline } from "../../legacy";
import type { Dictionaries } from "../../types";
import {
  assertEntityInvariants,
  assertRedactionInvariants,
} from "../assert-invariants";
import { contractTestConfig } from "../contract-config";
import { loadTestDictionaries } from "../load-dictionaries";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "contracts");

// All committed contract fixtures, exercised as a fan-out so the
// invariants below hold across languages and document shapes.
const FIXTURES = [
  "cs/asset-transfer-court-declensions.txt",
  "cs/database-cz-service-contract.txt",
  "cs/eagles-rental-agreement.txt",
  "cs/nakit-legal-services-framework.txt",
  "cs/patrik-nguyen-used-vehicle-sale.txt",
  "cs/probo-frame-purchase-contract.txt",
  "cs/sanofi-bonus-agreement.txt",
  "cs/vinci-donation-agreement.txt",
  "de/geschaeftsfuehrer-dienstvertrag.txt",
  "en/gt-biopharma-employment-amendment.txt",
  "en/healthcare-trust-employment-amendment.txt",
  "en/pra-group-employment-agreement.txt",
  "en/software-license-agreement.txt",
];

const CONFIG = contractTestConfig("pipeline-invariants-test");

let dictionaries: Dictionaries | null = null;
const getDictionaries = async (): Promise<Dictionaries> => {
  dictionaries ??= await loadTestDictionaries();
  return dictionaries;
};

const readFixture = (rel: string): string =>
  readFileSync(join(FIXTURES_DIR, rel), "utf8").replaceAll("\r\n", "\n");

describe("pipeline output invariants", () => {
  for (const rel of FIXTURES) {
    test(
      rel,
      async () => {
        const fullText = readFixture(rel);
        const context = createPipelineContext();
        const entities = await runPipeline({
          fullText,
          config: { ...CONFIG, dictionaries: await getDictionaries() },
          gazetteerEntries: [],
          context,
        });

        assertEntityInvariants(fullText, entities);

        // Redaction is well-formed and drops at most as many spans as
        // were detected (overlaps removed, never invented).
        const result = redactText(fullText, entities, undefined, context);
        assertRedactionInvariants(entities, result);
      },
      20_000,
    );
  }
});

describe("pipeline determinism", () => {
  test("the same input yields identical entities on re-run", async () => {
    const fullText = readFixture("en/software-license-agreement.txt");
    const dicts = await getDictionaries();
    const run = () =>
      runPipeline({
        fullText,
        config: { ...CONFIG, dictionaries: dicts },
        gazetteerEntries: [],
        context: createPipelineContext(),
      });

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  }, 30_000);
});
