import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  redactText,
  runPipeline,
} from "../../index";
import type { Dictionaries, PipelineConfig } from "../../types";
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
  workspaceId: "pipeline-invariants-test",
};

let dictionaries: Dictionaries | null = null;
const getDictionaries = async (): Promise<Dictionaries> => {
  dictionaries ??= await loadTestDictionaries();
  return dictionaries;
};

const readFixture = (rel: string): string =>
  readFileSync(join(FIXTURES_DIR, rel), "utf8").replaceAll("\r\n", "\n");

// The entity `text` is the display/placeholder form with internal
// whitespace collapsed; the offsets address the raw span. The
// redaction-safety invariant is therefore whitespace-insensitive:
// the collapsed slice must equal the collapsed text. This still
// catches truncation/misalignment (the offsets covering the wrong
// content) while allowing the intentional whitespace normalization.
const collapseWs = (s: string): string => s.replace(/\s+/g, " ").trim();

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

        for (const e of entities) {
          // Offsets address a real, non-empty region of the source.
          expect(e.start).toBeGreaterThanOrEqual(0);
          expect(e.end).toBeLessThanOrEqual(fullText.length);
          expect(e.start).toBeLessThan(e.end);
          // The offsets cover the entity's content (whitespace-
          // insensitive; see collapseWs). Catches the undershoot
          // class of bug where redaction would leave a fragment.
          expect(collapseWs(fullText.slice(e.start, e.end))).toBe(
            collapseWs(e.text),
          );
          // Score stays within the 0..1 invariant.
          expect(e.score).toBeGreaterThanOrEqual(0);
          expect(e.score).toBeLessThanOrEqual(1);
        }

        // Redaction is well-formed and drops at most as many spans as
        // were detected (overlaps removed, never invented).
        const result = redactText(fullText, entities, undefined, context);
        expect(result.entityCount).toBeLessThanOrEqual(entities.length);
        expect(typeof result.redactedText).toBe("string");
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
