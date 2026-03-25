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
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "test",
};

const detect = async (text: string, config?: Partial<PipelineConfig>) => {
  const ctx = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: { ...CONFIG, ...config },
    gazetteerEntries: [],
    context: ctx,
  });
};

describe("degree continuation past commas", () => {
  test("captures post-nominal degrees after name", async () => {
    const entities = await detect(
      "zastoupen: RNDr. Filipem Hartvichem, Ph.D., CSc., ředitelem",
    );
    const person = entities.find(
      (e) => e.label === "person",
    );
    expect(person).toBeDefined();
    expect(person!.text).toContain("Ph.D.");
    expect(person!.text).toContain("CSc.");
  });
});

describe("all-caps heading rejection (90% threshold)", () => {
  test("rejects org in mostly-uppercase heading", async () => {
    const entities = await detect(
      "PODPORA ÚČASTI MSP NA VELETRZÍCH (VIP preview)",
    );
    const orgs = entities.filter(
      (e) => e.label === "organization",
    );
    expect(orgs.length).toBe(0);
  });
});

describe("court triggers", () => {
  test("court trigger extracts following text as org", async () => {
    const entities = await detect(
      "Krajský soud v Ústí nad Labem, oddíl B",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeDefined();
    // Trigger "krajský soud" extracts the value
    // after it: "v Ústí nad Labem"
    expect(org!.text).toContain("Ústí nad Labem");
  });
});

describe("monetary amount slovy extension", () => {
  test("extends amount to include (slovy ...)", async () => {
    const entities = await detect(
      "1 529,-Kč (slovy jeden-tisíc-pět-set-dvacet-devět-korun)",
    );
    const amount = entities.find(
      (e) => e.label === "monetary amount",
    );
    expect(amount).toBeDefined();
    expect(amount!.text).toContain("slovy");
  });
});

describe("phone number with tel.: prefix", () => {
  test("catches tel.: followed by landline", async () => {
    const entities = await detect("tel.: 483 357 250");
    const phone = entities.find(
      (e) => e.label === "phone number",
    );
    expect(phone).toBeDefined();
    expect(phone!.text).toContain("483");
  });
});

describe("address prose rejection", () => {
  test("rejects long address entity without digits", async () => {
    const entities = await detect(
      "adresa: specifikovaná v tomto odstavci je rozhodující i pro jakékoli další subjekty",
    );
    const addr = entities.filter(
      (e) =>
        e.label === "address" && e.text.length > 40,
    );
    expect(addr.length).toBe(0);
  });
});

describe("NA legal form with non-ASCII prefix", () => {
  test("rejects NA when prefix has diacritics", async () => {
    const entities = await detect(
      "PODPORA ÚČASTI MSP NA VELETRZÍCH",
    );
    const orgs = entities.filter(
      (e) => e.label === "organization",
    );
    expect(orgs.length).toBe(0);
  });

  test("accepts NA with ASCII prefix", async () => {
    const entities = await detect(
      "Wells Fargo NA is a bank",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeDefined();
    expect(org!.text).toContain("Wells Fargo NA");
  });
});

describe("V preposition in address", () => {
  test("includes V at start of address", async () => {
    const entities = await detect(
      "se sídlem V Holešovičkách 41/94, 180 00 Praha 8",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).toContain("V Holešovičkách");
  });
});
