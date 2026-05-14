/**
 * Regression tests for the `State of` / `Commonwealth of`
 * jurisdiction trigger: the value must end at the state /
 * commonwealth / district name and never absorb the rest
 * of a forum-selection or governing-law clause.
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
  workspaceId: "jurisdiction-trigger-test",
};

const detect = async (text: string): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: { ...baseConfig, dictionaries },
    gazetteerEntries: [],
    context,
  });
};

describe("jurisdiction trigger boundary", () => {
  test("forum-selection clause with 'or' does not get absorbed", async () => {
    const text =
      "This Agreement shall be governed by the laws of the State of " +
      "Delaware or any other jurisdiction that would cause the application " +
      "of foreign law.";
    const entities = await detect(text);
    const juris = entities.find(
      (e) => e.label === "address" && e.text.startsWith("State of"),
    );
    expect(juris).toBeDefined();
    expect(juris?.text).toBe("State of Delaware");
  });

  test("federal-court clause does not run past the state name", async () => {
    const text =
      "(i) submits to the exclusive personal jurisdiction of any " +
      "federal court sitting in the State of Delaware in the event " +
      "any dispute arises out of this Agreement.";
    const entities = await detect(text);
    const longJuris = entities.find(
      (e) => e.label === "address" && e.text.length > 25,
    );
    expect(longJuris).toBeUndefined();
  });

  test("closing parenthesis terminates the to-next-comma scan", async () => {
    // Even with no comma between the trigger and the closing
    // paren, the to-next-comma strategy must stop at `)` so the
    // captured value does not run into the next sentence.
    const text = "(governing law clause cites the State of New York)";
    const entities = await detect(text);
    const juris = entities.find(
      (e) => e.label === "address" && e.text.startsWith("State of"),
    );
    expect(juris?.text).toBe("State of New York");
  });

  test("plain Delaware corporation phrase still resolves to State of <X>", async () => {
    // The healthy short-form case must keep working.
    const text =
      "The Merger shall be governed by the laws of the State of Delaware.";
    const entities = await detect(text);
    const juris = entities.find(
      (e) => e.label === "address" && e.text.startsWith("State of"),
    );
    expect(juris).toBeDefined();
    expect(juris?.text.startsWith("State of Delaware")).toBe(true);
  });
});
