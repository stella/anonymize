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

describe("NA filter does not reject dotted Czech forms", () => {
  // Unit-level test for processLegalFormMatches:
  // the NA/PA short-suffix filter must not reject
  // dotted Czech forms (a.s., k.s.) even when the
  // prefix contains diacritics.
  test("keeps a.s. with diacritics via processLegalFormMatches", () => {
    const { processLegalFormMatches } = require(
      "../detectors/legal-forms",
    );
    const fullText =
      "podepsaná Čistá Energie a.s. dne 1. 1. 2020";
    // Simulate a regex match for "Čistá Energie a.s."
    const fakeMatch = {
      pattern: 0,
      start: 10,
      end: 28,
      text: "Čistá Energie a.s.",
    };
    const results = processLegalFormMatches(
      [fakeMatch],
      0,
      1,
      fullText,
    );
    expect(results.length).toBe(1);
    expect(results[0]!.text).toBe("Čistá Energie a.s.");
  });

  test("rejects NA with diacritics prefix", () => {
    const { processLegalFormMatches } = require(
      "../detectors/legal-forms",
    );
    const fullText =
      "PODPORA ÚČASTI MSP NA VELETRZÍCH";
    const fakeMatch = {
      pattern: 0,
      start: 8,
      end: 21,
      text: "ÚČASTI MSP NA",
    };
    const results = processLegalFormMatches(
      [fakeMatch],
      0,
      1,
      fullText,
    );
    expect(results.length).toBe(0);
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

// ── Fix batch 6 tests ──────────────────────────────

describe("address stops at field-label keywords", () => {
  test("stops before IČ", async () => {
    const entities = await detect(
      "sídlem: Dělnická 213/12, 170 00, Praha 7, IČ: 25672541",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).not.toContain("IČ");
    expect(addr!.text).toContain("Praha 7");
  });

  test("stops before DIČ", async () => {
    const entities = await detect(
      "sídlem: Lipová 42, 110 00 Praha 1, DIČ: CZ123",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).not.toContain("DIČ");
  });

  test("stops before oddíl", async () => {
    const entities = await detect(
      "sídlem: Lipová 42, Praha 1, oddíl B",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).not.toContain("oddíl");
  });
});

describe("includeTrigger for court names", () => {
  test("includes trigger in entity span", async () => {
    const entities = await detect(
      "Krajský soud v Ústí nad Labem, oddíl B",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeDefined();
    expect(org!.text).toStartWith("Krajský soud");
    expect(org!.text).toContain("Ústí nad Labem");
  });

  test("genitive form includes trigger", async () => {
    const entities = await detect(
      "u Krajského soudu v Praze, oddíl C",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeDefined();
    expect(org!.text).toContain("Krajského soudu");
    expect(org!.text).toContain("Praze");
  });
});

describe("SWIFT/BIC trigger detection", () => {
  test("detects SWIFT code", async () => {
    const entities = await detect(
      "SWIFT: GIBACZPX",
    );
    const bank = entities.find(
      (e) => e.label === "bank account number",
    );
    expect(bank).toBeDefined();
    expect(bank!.text).toBe("GIBACZPX");
  });

  test("detects BIC code", async () => {
    const entities = await detect(
      "BIC: COBADEFFXXX",
    );
    const bank = entities.find(
      (e) => e.label === "bank account number",
    );
    expect(bank).toBeDefined();
    expect(bank!.text).toBe("COBADEFFXXX");
  });

  test("rejects short SWIFT code", async () => {
    const entities = await detect(
      "SWIFT: ABC",
    );
    const bank = entities.find(
      (e) =>
        e.label === "bank account number" &&
        e.text === "ABC",
    );
    expect(bank).toBeUndefined();
  });
});

describe("organization name propagation", () => {
  test("propagates base org name without suffix", async () => {
    const text =
      "Zhotovitel: VINCI Construction CS a.s., " +
      "IČO: 12345678\n" +
      "VINCI Construction CS provádí práce.";
    const entities = await detect(text);
    const orgs = entities.filter(
      (e) => e.label === "organization",
    );
    // Should find the original with suffix via trigger
    expect(
      orgs.some((e) =>
        e.text.includes("VINCI Construction CS a.s."),
      ),
    ).toBe(true);
    // The bare mention should be propagated
    expect(
      orgs.some(
        (e) =>
          e.text === "VINCI Construction CS" &&
          !e.text.includes("a.s."),
      ),
    ).toBe(true);
    expect(orgs.length).toBeGreaterThanOrEqual(2);
  });
});
