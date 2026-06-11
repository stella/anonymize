import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  redactText,
  runPipeline,
} from "../index";
import type { PipelineConfig } from "../types";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "test",
};

const redactWith = async (
  fullText: string,
  ctx = createPipelineContext(),
): Promise<string> => {
  const entities = await runPipeline({
    fullText,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  return redactText(fullText, entities, undefined, ctx).redactedText;
};

describe("org propagation placeholder consistency", () => {
  test("bare mention gets the same placeholder as the full form", async () => {
    const redacted = await redactWith(
      `This deed is made by Initech Corporation, a Delaware corporation. ` +
        `The obligations of Initech are set out below.`,
    );
    // Full form and propagated bare mention must share one
    // placeholder so the redacted document stays readable
    // and the de-anonymization key stays unambiguous.
    expect(redacted).toContain("[ORGANIZATION_1], a Delaware");
    expect(redacted).toContain("The obligations of [ORGANIZATION_1]");
    expect(redacted).not.toContain("[ORGANIZATION_2]");
  });

  test("two parties keep distinct placeholders across bare mentions", async () => {
    const redacted = await redactWith(
      `This Agreement is between Acme Corporation, a Delaware ` +
        `corporation, and GlobalTech Solutions Inc., a California ` +
        `corporation. Acme shall pay GlobalTech Solutions within 30 days.`,
    );
    const tags = [...redacted.matchAll(/\[ORGANIZATION_(\d)\]/g)].map(
      (m) => m[1],
    );
    // Acme + GlobalTech, each mentioned twice, in order.
    expect(tags).toEqual(["1", "2", "1", "2"]);
  });

  test("reused context does not leak placeholder links across documents", async () => {
    const ctx = createPipelineContext();
    await redactWith(
      `This deed is made by GlobalTech Solutions Inc., a California ` +
        `corporation. The obligations of GlobalTech Solutions apply.`,
      ctx,
    );
    const second = await redactWith(
      `This deed is made by Initech Corporation, a Delaware corporation. ` +
        `The obligations of Initech are set out below.`,
      ctx,
    );
    expect(second).toContain("The obligations of [ORGANIZATION_1]");
    expect(second).not.toContain("[ORGANIZATION_2]");
  });

  test("bare mention before the full form shares its placeholder", async () => {
    const redacted = await redactWith(
      `Initech term sheet. This deed is made by Initech Corporation, ` +
        `a Delaware corporation.`,
    );
    // The forward alias reserves the placeholder under
    // the source key, so the later full form joins it
    // instead of allocating a second number.
    expect(redacted).toContain("[ORGANIZATION_1] term sheet");
    expect(redacted).toContain("made by [ORGANIZATION_1],");
    expect(redacted).not.toContain("[ORGANIZATION_2]");
  });

  test("forward alias stores the source's full text in the redaction key", async () => {
    const ctx = createPipelineContext();
    const fullText =
      `Initech term sheet. This deed is made by Initech Corporation, ` +
      `a Delaware corporation.`;
    const entities = await runPipeline({
      fullText,
      config: CONFIG,
      gazetteerEntries: [],
      context: ctx,
    });
    const result = redactText(fullText, entities, undefined, ctx);
    // The alias occurs first, but the key's canonical
    // value must be the full source form so deanonymise
    // restores the complete name.
    expect(result.redactionMap.get("[ORGANIZATION_1]")).toBe(
      "Initech Corporation",
    );
  });

  test("bare mention with two competing sources keeps its own placeholder", async () => {
    const redacted = await redactWith(
      `Initech LLC and Initech Corporation are affiliates. ` +
        `Initech shall notify both parties.`,
    );
    const tags = [...redacted.matchAll(/\[ORGANIZATION_(\d)\]/g)].map(
      (m) => m[1],
    );
    // Forcing the bare mention onto either full form
    // would corrupt the redaction key, so it gets its
    // own placeholder.
    expect(tags).toEqual(["1", "2", "3"]);
  });
});
