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

const expectOrg = async (text: string, expected: string) => {
  const ctx = createPipelineContext();
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  const org = entities.find((e) => e.label === "organization");
  expect(org).toBeDefined();
  expect(org!.text).toBe(expected);
};

const expectNoOrg = async (text: string) => {
  const ctx = createPipelineContext();
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  const orgs = entities.filter((e) => e.label === "organization");
  expect(orgs.length).toBe(0);
};

// ── Czech s.r.o. ──────────────────────────────

describe("Czech s.r.o. companies", () => {
  test("simple two-word", async () => {
    await expectOrg("Qubus s.r.o.", "Qubus s.r.o.");
  });

  test("with ampersand connector", async () => {
    await expectOrg("Auto Kubíček s.r.o.", "Auto Kubíček s.r.o.");
  });

  test("all-caps brand + mixed", async () => {
    await expectOrg(
      "MAKRO Cash & Carry ČR s.r.o.",
      "MAKRO Cash & Carry ČR s.r.o.",
    );
  });

  test("hyphenated name", async () => {
    await expectOrg("Indu-Light Praha s.r.o.", "Indu-Light Praha s.r.o.");
  });

  test("short country code", async () => {
    await expectOrg("Metrostav CZ s.r.o.", "Metrostav CZ s.r.o.");
  });

  test("spol. s r.o. variant", async () => {
    await expectOrg("BAS Rudice spol. s r.o.", "BAS Rudice spol. s r.o.");
  });

  test("ROTHLEHNER pracovní plošiny s.r.o.", async () => {
    await expectOrg(
      "ROTHLEHNER pracovní plošiny s.r.o.",
      "ROTHLEHNER pracovní plošiny s.r.o.",
    );
  });

  test("English words in name", async () => {
    await expectOrg("Be a Future s.r.o.", "Be a Future s.r.o.");
  });
});

// ── Czech a.s. ────────────────────────────────

describe("Czech a.s. companies", () => {
  test("simple", async () => {
    await expectOrg("Leastex, a.s.", "Leastex, a.s.");
  });

  test("multi-word with country", async () => {
    await expectOrg("VINCI Construction CS a.s.", "VINCI Construction CS a.s.");
  });

  test("bank name", async () => {
    await expectOrg("Komerční banky, a.s.", "Komerční banky, a.s.");
  });

  test("with a. s. (spaced)", async () => {
    await expectOrg(
      "Technologie hlavního města Prahy, a. s.",
      "Technologie hlavního města Prahy, a. s.",
    );
  });

  test("RENATEX CZ a.s.", async () => {
    await expectOrg("RENATEX CZ a.s.", "RENATEX CZ a.s.");
  });
});

// ── Other Czech forms ─────────────────────────

describe("other Czech legal forms", () => {
  test("z.s. (spolek)", async () => {
    await expectOrg("EAGLES BRNO, z.s.", "EAGLES BRNO, z.s.");
  });

  test("z.ú. (ústav)", async () => {
    await expectOrg("České Budějovice z.ú.", "České Budějovice z.ú.");
  });

  test("příspěvková organizace", async () => {
    await expectOrg(
      "Moravskoslezská nemocnice příspěvková organizace",
      "Moravskoslezská nemocnice příspěvková organizace",
    );
  });

  test("comma before příspěvková organizace", async () => {
    await expectOrg(
      "Krajská správa, příspěvková organizace",
      "Krajská správa, příspěvková organizace",
    );
  });

  test("státní podnik s.p.", async () => {
    await expectOrg("Česká pošta s.p.", "Česká pošta s.p.");
  });

  test("long state enterprise name", async () => {
    await expectOrg(
      "Národní agentura pro komunikační a informační technologie, s. p.",
      "Národní agentura pro komunikační a informační technologie, s. p.",
    );
  });
});

// ── German forms ──────────────────────────────

describe("German legal forms", () => {
  test("GmbH", async () => {
    await expectOrg("Siemens GmbH", "Siemens GmbH");
  });

  test("AG", async () => {
    await expectOrg("Deutsche Bank AG", "Deutsche Bank AG");
  });
});

// ── False positives to reject ─────────────────

describe("should NOT detect organization", () => {
  test("all-caps heading with NA", async () => {
    await expectNoOrg("PODPORA ÚČASTI MSP NA VELETRZÍCH");
  });

  test("all-caps heading (90% threshold)", async () => {
    await expectNoOrg("PODPORA ÚČASTI NA VELETRZÍCH (preview)");
  });
});
