import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  runPipeline,
  DEFAULT_ENTITY_LABELS,
  createPipelineContext,
} from "../legacy";
import type { PipelineConfig } from "../types";

setDefaultTimeout(15_000);

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

let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;
const getCtx = () => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const expectOrg = async (text: string, expected: string) => {
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: getCtx(),
  });
  const org = entities.find((e) => e.label === "organization");
  expect(org).toBeDefined();
  expect(org!.text).toBe(expected);
};

const expectOrgs = async (text: string, expected: string[]) => {
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: getCtx(),
  });
  const orgs = entities
    .filter((e) => e.label === "organization")
    .map((e) => e.text)
    .sort();
  expect(orgs).toEqual(expected.sort());
};

const expectNoOrg = async (text: string) => {
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: getCtx(),
  });
  const orgs = entities.filter((e) => e.label === "organization");
  expect(orgs.length).toBe(0);
};

const expectOrgBeatsCityAddress = async (text: string, expected: string) => {
  const entities = await runPipeline({
    fullText: text,
    config: {
      ...CONFIG,
      enableDenyList: true,
      dictionaries: { cities: ["Bratislava"] },
    },
    gazetteerEntries: [],
    context: createPipelineContext(),
  });
  expect(
    entities.some((e) => e.label === "organization" && e.text === expected),
  ).toBe(true);
  expect(
    entities.some((e) => e.label === "address" && e.text === "Bratislava"),
  ).toBe(false);
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

  test("DOCX non-breaking spaces in company name", async () => {
    await expectOrg("IKEA Bratislava, s.r.o.", "IKEA Bratislava, s.r.o.");
  });

  test("organization span beats inner city address", async () => {
    await expectOrgBeatsCityAddress(
      "IKEA Bratislava, s.r.o.",
      "IKEA Bratislava, s.r.o.",
    );
  });

  test("clause text before by is trimmed from company name", async () => {
    await expectOrg(
      "THIS CERTIFIES THAT in exchange for the joint payment by  IKEA Bratislava, s.r.o., IČ 35 849 436",
      "IKEA Bratislava, s.r.o.",
    );
  });

  test("clause-trimmed organization span beats inner city address", async () => {
    await expectOrgBeatsCityAddress(
      "THIS CERTIFIES THAT in exchange for the joint payment by  IKEA Bratislava, s.r.o., IČ 35 849 436",
      "IKEA Bratislava, s.r.o.",
    );
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

  test("date prefix before comma is trimmed from company name", async () => {
    await expectOrg(
      "29 August 2024, The Swatch Group AG, CHE-101.374.515",
      "The Swatch Group AG",
    );
  });
});

// ── SEC merger agreement regressions ───────────────

describe("SEC merger agreement organizations", () => {
  test("preamble party list keeps each legal-form entity", async () => {
    await expectOrgs(
      "by and among X Holdings I, Inc., X Holdings II, Inc. and Twitter, Inc.",
      ["X Holdings I, Inc.", "X Holdings II, Inc.", "Twitter, Inc."],
    );
  });

  test("financial advisor comma list keeps full organization names", async () => {
    await expectOrgs(
      "Goldman Sachs & Co. LLC, J.P. Morgan Securities LLC and Allen & Company LLC",
      [
        "Goldman Sachs & Co. LLC",
        "J.P. Morgan Securities LLC",
        "Allen & Company LLC",
      ],
    );
  });

  test("edgar line wrap before terminal suffix stays in one organization", async () => {
    await expectOrg(
      "between the Company and Goldman Sachs & Co.\nLLC, (iv) the call option",
      "Goldman Sachs & Co. LLC",
    );
  });

  test("national bank suffix keeps dotted N.A. legal form", async () => {
    await expectOrg(
      "between the Company and Bank of America, N.A., (ii) the warrant confirmation",
      "Bank of America, N.A.",
    );
  });
});

// ── Connector separation ─────────────────────

describe("connector separation", () => {
  test("two entities separated by connector", async () => {
    await expectOrgs("RELAKA s.r.o. a AGROBIOPLYN s.r.o.", [
      "RELAKA s.r.o.",
      "AGROBIOPLYN s.r.o.",
    ]);
  });

  test("backward extension through connector", async () => {
    await expectOrg("Be a Future s.r.o.", "Be a Future s.r.o.");
  });

  test("long name with internal connectors", async () => {
    await expectOrg(
      "Krajská správa a údržba silnic Vysočiny, příspěvková organizace",
      "Krajská správa a údržba silnic Vysočiny, příspěvková organizace",
    );
  });

  test("ampersand in company name", async () => {
    await expectOrg(
      "MAKRO Cash & Carry ČR s.r.o.",
      "MAKRO Cash & Carry ČR s.r.o.",
    );
  });

  test("two-word name plus and Company suffix", async () => {
    await expectOrg(
      "Acme Widgets and Company, Inc.",
      "Acme Widgets and Company, Inc.",
    );
  });

  test("name plus and Company across in-name preposition", async () => {
    await expectOrg(
      "The Bank of America and Trust Company, Inc.",
      "The Bank of America and Trust Company, Inc.",
    );
  });

  test("person and company boundary preserved", async () => {
    await expectOrgs("Paul Newman and Apple, Inc.", ["Apple, Inc."]);
  });

  test("multi-word org with internal and connector", async () => {
    await expectOrg(
      "UniCredit Bank Czech Republic and Slovakia, a.s.",
      "UniCredit Bank Czech Republic and Slovakia, a.s.",
    );
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

// ── Role-head sentence-fragment trimming ──────

describe("role-head sentence trim", () => {
  test("Czech sentence fragment trimmed to trailing org", async () => {
    await expectOrgs(
      "Prodávající 1 je vlastníkem podílu ve společnosti Acme s.r.o.",
      ["Acme s.r.o."],
    );
  });

  test("trim preserves multi-word trailing org name", async () => {
    await expectOrgs("Vendor 1 owns Acme Holdings s.r.o. in this deal.", [
      "Acme Holdings s.r.o.",
    ]);
  });

  test("trim preserves in-name preposition (Bank of America)", async () => {
    await expectOrgs("Vendor grants Bank of America Inc. exclusive rights.", [
      "Bank of America Inc.",
    ]);
  });

  test("role word that IS the company is kept (no trim)", async () => {
    await expectOrg("Vendor s.r.o. and its subsidiaries.", "Vendor s.r.o.");
  });

  test("cap-only chain starting with role word is kept (no trim)", async () => {
    await expectOrg(
      "Client Solutions Inc. delivered the project.",
      "Client Solutions Inc.",
    );
  });

  test("trim preserves Czech state form with lowercase tail", async () => {
    await expectOrgs(
      "Prodávající vlastní Národní agentura pro komunikační a informační technologie, s. p.",
      ["Národní agentura pro komunikační a informační technologie, s. p."],
    );
  });

  test("trim handles multi-token legal suffix (spol. s r.o.)", async () => {
    await expectOrgs(
      "Prodávající vlastní Acme spol. s r.o. v této transakci.",
      ["Acme spol. s r.o."],
    );
  });

  test("role-word name with lowercase descriptive word is kept", async () => {
    await expectOrg(
      "Client solutions Inc. delivered the project.",
      "Client solutions Inc.",
    );
  });

  test("English Corp. anchors via the full legal-form vocabulary", async () => {
    await expectOrgs("Vendor owns Acme Corp. through a subsidiary.", [
      "Acme Corp.",
    ]);
  });

  test("clause noun between verb and org is skipped", async () => {
    await expectOrgs("Vendor signed Agreement with Acme Inc. last quarter.", [
      "Acme Inc.",
    ]);
  });

  test("appositive role-head after a sentence verb is skipped", async () => {
    await expectOrgs("Vendor grants Licensee Acme Inc. a license.", [
      "Acme Inc.",
    ]);
  });

  test("title-cased sentence verb (Owns) still triggers the trim", async () => {
    await expectOrgs("Vendor Owns Acme Inc.", ["Acme Inc."]);
  });
});

describe("court triggers with stop-words", () => {
  test("instrumental court stops before 'dne' when no comma", async () => {
    await expectOrgs("Městským soudem v Praze dne 1. 1. 2020 vydán nález.", [
      "Městským soudem v Praze",
    ]);
  });
});

describe("long state-form legal names", () => {
  test("ten-token lowercase tail still matches as one entity", async () => {
    await expectOrg(
      "Národní agentura pro podporu rozvoje vzdělávání kultury sportu mládeže republiky, z.s.",
      "Národní agentura pro podporu rozvoje vzdělávání kultury sportu mládeže republiky, z.s.",
    );
  });
});
