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

  test("single-letter party with comma before suffix is captured", async () => {
    const orgs = await collectOrgs(`X, Inc. signed the joinder.`);
    expect(orgs).toContain("X, Inc.");
  });

  test("single-letter party after middle-initial person does not absorb surname", async () => {
    const orgs = await collectOrgs(`Elon R. Musk and X Corp. signed.`);
    expect(orgs).toContain("X Corp.");
    expect(orgs).not.toContain("Musk and X Corp.");
  });

  test("single-letter holding company after middle-initial person does not absorb surname", async () => {
    const orgs = await collectOrgs(
      `Elon R. Musk and X Holdings I, Inc. signed.`,
    );
    expect(orgs).toContain("X Holdings I, Inc.");
    expect(orgs).not.toContain("Musk and X Holdings I, Inc.");
  });

  test("schedule labels and uppercase word prefixes are not treated as companies", async () => {
    const orgs = await collectOrgs(
      `Schedule A LLC Members and Article X Corp. Governance are headings. Exhibit X SEAL is attached. SCHEDULE A LLC Members and Exhibit A-1 LLC Agreement are labels.`,
    );
    expect(orgs).not.toContain("Schedule A LLC");
    expect(orgs).not.toContain("A LLC");
    expect(orgs).not.toContain("Article X Corp.");
    expect(orgs).not.toContain("X Corp.");
    expect(orgs).not.toContain("Exhibit X SE");
    expect(orgs).not.toContain("SCHEDULE A LLC");
    expect(orgs).not.toContain("Exhibit A-1 LLC");
  });

  test("coordinated company names before and are preserved", async () => {
    const orgs = await collectOrgs(
      `John Smith and Company, Inc., Acme Technologies and X Holdings I, Inc., and Acme Medical Devices and Research LLC signed.`,
    );
    expect(orgs).toEqual(
      expect.arrayContaining([
        "John Smith and Company, Inc.",
        "Acme Technologies and X Holdings I, Inc.",
        "Acme Medical Devices and Research LLC",
      ]),
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
