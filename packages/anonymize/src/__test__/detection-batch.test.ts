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

  test("does NOT false-stop on city starting with 'tel' (Telč)", async () => {
    const entities = await detect(
      "sídlem: Hradecká 5, 588 56, Telč, IČ: 25672541",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).toContain("Telč");
    expect(addr!.text).not.toContain("IČ");
  });

  test("stops before keyword immediately followed by digits (no space)", async () => {
    const entities = await detect(
      "sídlem: Dělnická 213/12, 170 00, Praha 7, ič25672541",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).not.toContain("ič");
    expect(addr!.text).toContain("Praha 7");
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
    const entities = await detect(text, {
      enableCoreference: true,
    });
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

  test("does not emit overlapping propagated entities from two seeds", async () => {
    const text =
      "Objednatel: ACME Czech s.r.o., IČO: 12345678\n" +
      "Zhotovitel: ACME Czech Industrial a.s., IČO: 87654321\n" +
      "ACME Czech dodává materiál.";
    const entities = await detect(text, {
      enableCoreference: true,
    });
    const orgs = entities.filter(
      (e) => e.label === "organization",
    );
    // "ACME Czech" from second seed must not overlap
    // with a propagated span from the first seed.
    const propagated = orgs.filter(
      (e) => e.text === "ACME Czech",
    );
    // Each position should appear at most once
    const starts = propagated.map((e) => e.start);
    const uniqueStarts = new Set(starts);
    expect(uniqueStarts.size).toBe(starts.length);
  });

  test("skips propagation when enableCoreference is false", async () => {
    const text =
      "Zhotovitel: VINCI Construction CS a.s., " +
      "IČO: 12345678\n" +
      "VINCI Construction CS provádí práce.";
    const entities = await detect(text, {
      enableCoreference: false,
    });
    const bareOrgs = entities.filter(
      (e) =>
        e.label === "organization" &&
        e.text === "VINCI Construction CS",
    );
    expect(bareOrgs.length).toBe(0);
  });

  test("does not match base name adjacent to digits", async () => {
    const text =
      "Zhotovitel: ACME Czech s.r.o., " +
      "IČO: 12345678\n" +
      "ACME Czech provádí práce.\n" +
      "Ref: ACME Czech2 není totéž.";
    const entities = await detect(text, {
      enableCoreference: true,
    });
    const propagated = entities.filter(
      (e) =>
        e.label === "organization" &&
        e.text === "ACME Czech",
    );
    // The standalone "ACME Czech" must be propagated
    // (positive guard against vacuous pass).
    expect(propagated.length).toBeGreaterThanOrEqual(1);
    // "ACME Czech" in "ACME Czech2" must NOT be matched
    // (digit boundary guard). Only the standalone mention
    // should be propagated.
    for (const e of propagated) {
      const nextCh = text[e.end] ?? "";
      expect(/\d/.test(nextCh)).toBe(false);
    }
  });
});

// ── Fix batch 7 tests ──────────────────────────────

describe("Adr. korespondenční address trigger", () => {
  test("detects address after Adr. korespondenční", async () => {
    const entities = await detect(
      "Adr. korespondenční: Bezručova 1250, 572 01 Polička",
    );
    const addr = entities.find(
      (e) => e.label === "address",
    );
    expect(addr).toBeDefined();
    expect(addr!.text).toContain("Bezručova");
  });
});

describe("org role starts-uppercase validation", () => {
  test("rejects lowercase value after objednatel", async () => {
    const entities = await detect(
      "objednatel na straně jedné",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeUndefined();
  });

  test("accepts uppercase value after objednatel", async () => {
    const entities = await detect(
      "objednatel: Město Brno, IČO: 12345678",
    );
    const org = entities.find(
      (e) => e.label === "organization",
    );
    expect(org).toBeDefined();
    expect(org!.text).toContain("Město Brno");
  });
});

describe("digit-starting token in backward scan", () => {
  test("includes 28. října in address", async () => {
    const entities = await detect(
      "sídlem: 28. října 1168/102, 702 00 Ostrava",
      { enableConfidenceBoost: true },
    );
    const addr = entities.find(
      (e) =>
        e.label === "address" &&
        e.text.includes("října"),
    );
    expect(addr).toBeDefined();
    expect(addr!.text).toContain("28");
  });
});

describe("ve výši monetary trigger", () => {
  test("detects amount after ve výši", async () => {
    const entities = await detect(
      "ve výši 275.000 Kč",
    );
    const amount = entities.find(
      (e) => e.label === "monetary amount",
    );
    expect(amount).toBeDefined();
    expect(amount!.text).toContain("275");
  });
});

describe("M.Sc. / B.Sc. post-nominals", () => {
  test("captures M.Sc. after name", async () => {
    const entities = await detect(
      "zastoupen: Janem Novákem, M.Sc., ředitelem",
    );
    const person = entities.find(
      (e) => e.label === "person",
    );
    expect(person).toBeDefined();
    expect(person!.text).toContain("M.Sc.");
  });
});
