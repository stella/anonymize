import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

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
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "fr-headline-trigger-test",
};

let cachedDictionaries: Dictionaries | undefined;
const getDictionaries = async () => {
  if (!cachedDictionaries) {
    cachedDictionaries = await loadTestDictionaries();
  }
  return cachedDictionaries;
};

const runFr = async (text: string) => {
  const dictionaries = await getDictionaries();
  return runPipeline({
    fullText: text,
    config: { ...CONFIG, dictionaries },
    gazetteerEntries: [],
    context: createPipelineContext(),
  });
};

describe("French headline-style trigger regressions", () => {
  test("phone trigger does not steal a following SIREN value", async () => {
    const text = "Téléphone : non communiqué SIREN : 123456789";
    const ents = await runFr(text);
    const phoneEnts = ents.filter((e) => e.label === "phone number");
    expect(phoneEnts.length).toBe(0);
    const regEnts = ents.filter((e) => e.label === "registration number");
    expect(regEnts.some((e) => e.text.includes("123456789"))).toBe(true);
  });

  test("VAT trigger extracts spaced letter-leading FR keys", async () => {
    const text = "TVA : FR A1 123456789 et autres.";
    const ents = await runFr(text);
    const tvaEnts = ents.filter((e) => e.label === "tax identification number");
    expect(tvaEnts.length).toBeGreaterThan(0);
    expect(tvaEnts.some((e) => e.text.includes("A1"))).toBe(true);
  });

  test("elided court preposition (d') is captured", async () => {
    const text =
      "Saisine de la Cour d'appel d'Aix-en-Provence par le demandeur.";
    const ents = await runFr(text);
    const orgEnts = ents.filter((e) => e.label === "organization");
    expect(orgEnts.some((e) => e.text.includes("Aix-en-Provence"))).toBe(true);
  });

  test("legal-form alias is not propagated via coreference", async () => {
    const text = "ACME SAS (« SAS ») agit. Une autre SAS apparaît ici.";
    const ents = await runFr(text);
    // Find the trailing standalone "SAS" — at the position
    // after "Une autre ".
    const trailingIdx = text.indexOf("Une autre SAS");
    expect(trailingIdx).toBeGreaterThan(0);
    const trailingSasStart = trailingIdx + "Une autre ".length;
    const collisions = ents.filter(
      (e) =>
        e.label === "organization" &&
        e.start === trailingSasStart &&
        text.slice(e.start, e.end).trim() === "SAS",
    );
    expect(collisions.length).toBe(0);
  });

  test("address headline trigger is bounded before email field", async () => {
    const text = "Adresse : 10 rue de la Paix Email : a@b.fr";
    const ents = await runFr(text);
    const addresses = ents.filter((e) => e.label === "address");
    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) {
      expect(a.text.toLowerCase()).not.toContain("a@b.fr");
      expect(a.text.toLowerCase()).not.toContain("email");
    }
  });

  test("court trigger stops before 'par' clause when no comma", async () => {
    const text = "Cour d'appel de Paris par le demandeur";
    const ents = await runFr(text);
    const orgs = ents.filter((e) => e.label === "organization");
    expect(orgs.length).toBeGreaterThan(0);
    for (const o of orgs) {
      expect(o.text.toLowerCase()).not.toContain("par le demandeur");
      expect(o.text.toLowerCase()).not.toContain("demandeur");
    }
  });

  test("compact colon address headline captures letter-leading value", async () => {
    // No space after the colon and the value starts with a
    // letter. Before the boundary-check fix, the trigger
    // was rejected outright; now it fires and the address
    // strategy captures the city + street.
    const text = "Adresse:Paris 10 rue de la Paix.";
    const ents = await runFr(text);
    const addresses = ents.filter((e) => e.label === "address");
    expect(addresses.some((a) => a.text.toLowerCase().includes("paris"))).toBe(
      true,
    );
  });

  test("SIREN n° with no space captures the digits", async () => {
    const text = "SIREN n°123456789 du registre.";
    const ents = await runFr(text);
    const regs = ents.filter((e) => e.label === "registration number");
    expect(regs.some((e) => e.text.includes("123456789"))).toBe(true);
  });

  test("street-type words keep no-digit French addresses", async () => {
    const text = "Adresse : avenue Victor Hugo";
    const ents = await runFr(text);
    const addresses = ents.filter((e) => e.label === "address");
    expect(
      addresses.some((a) => a.text.toLowerCase().includes("avenue victor")),
    ).toBe(true);
  });

  test("court trigger captures contracted 'du' article", async () => {
    const text = "Tribunal judiciaire du Mans statue sur l'affaire.";
    const ents = await runFr(text);
    const orgs = ents.filter((e) => e.label === "organization");
    expect(orgs.some((o) => o.text.includes("Mans"))).toBe(true);
  });

  test("court trigger captures contracted 'des' article", async () => {
    const text =
      "Conseil de prud'hommes des Sables-d'Olonne a rendu son jugement.";
    const ents = await runFr(text);
    const orgs = ents.filter((e) => e.label === "organization");
    expect(orgs.some((o) => o.text.includes("Sables-d'Olonne"))).toBe(true);
  });

  test("court trigger keeps city with hyphenated -sur- segment", async () => {
    const text = "Tribunal judiciaire de Saint-Maur-sur-Loire, chambre 1.";
    const ents = await runFr(text);
    const orgs = ents.filter((e) => e.label === "organization");
    expect(orgs.some((o) => o.text.includes("Saint-Maur-sur-Loire"))).toBe(
      true,
    );
  });

  test("person trigger reclassifies SASU (full-vocab suffix) as organization", async () => {
    const text = "Le mandat est exécuté agissant par ACME SASU.";
    const ents = await runFr(text);
    const acme = ents.find((e) => e.text.includes("ACME SASU"));
    expect(acme).toBeDefined();
    expect(acme?.label).toBe("organization");
  });

  test("hyphenated French role head (Sous-traitant) is trimmed off org match", async () => {
    const text = "Sous-traitant est Acme SAS pour ce projet.";
    const ents = await runFr(text);
    const orgs = ents.filter((e) => e.label === "organization");
    expect(orgs.some((o) => o.text.startsWith("Acme"))).toBe(true);
    for (const o of orgs) {
      expect(o.text.toLowerCase()).not.toContain("sous-traitant");
    }
  });
});
