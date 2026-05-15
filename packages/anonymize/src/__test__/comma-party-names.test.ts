import { describe, expect, test } from "bun:test";
import {
  runPipeline,
  DEFAULT_ENTITY_LABELS,
  createPipelineContext,
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
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "test",
};

const collectOrgs = async (text: string): Promise<string[]> => {
  const ctx = createPipelineContext();
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  return entities.filter((e) => e.label === "organization").map((e) => e.text);
};

describe("party names with internal comma before legal form", () => {
  test("Twitter, Inc. anchored in a Delaware clause", async () => {
    const orgs = await collectOrgs(
      `Twitter, Inc., a Delaware corporation, owns assets.`,
    );
    expect(orgs).toContain("Twitter, Inc.");
  });

  test("single-letter Roman-numeral suffix inside the name", async () => {
    const orgs = await collectOrgs(
      `X Holdings I, Inc., a Delaware corporation, signed.`,
    );
    expect(orgs).toContain("X Holdings I, Inc.");
  });

  test("two-letter Roman-numeral suffix inside the name", async () => {
    const orgs = await collectOrgs(
      `X Holdings II, Inc., a Delaware corporation, signed.`,
    );
    expect(orgs).toContain("X Holdings II, Inc.");
  });

  test("single-letter Cap head with bare Corp. suffix", async () => {
    const orgs = await collectOrgs(
      `among Twitter, Inc. and X Corp. and Other LLC for purposes hereof.`,
    );
    expect(orgs).toEqual(
      expect.arrayContaining(["Twitter, Inc.", "X Corp.", "Other LLC"]),
    );
  });

  test("Twitter merger preamble — all three corporate parties detected", async () => {
    const orgs = await collectOrgs(
      `THIS AGREEMENT AND PLAN OF MERGER, dated as of April 25, 2022 (this "Agreement"), is made by and among Twitter, Inc., a Delaware corporation (the "Company"), X Holdings I, Inc., a Delaware corporation ("Parent"), X Holdings II, Inc., a Delaware corporation and a direct wholly owned Subsidiary of Parent ("Acquisition Sub"), and Elon R. Musk (the "Equity Investor").`,
    );
    expect(orgs).toEqual(
      expect.arrayContaining([
        "Twitter, Inc.",
        "X Holdings I, Inc.",
        "X Holdings II, Inc.",
      ]),
    );
  });
});
