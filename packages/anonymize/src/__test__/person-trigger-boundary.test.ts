/**
 * Regression tests for the person name-run boundary on
 * trigger-phrase extraction: an honorific trigger ("Pan",
 * "paní") with a delimiter-scanning strategy must capture
 * only the run of name-shaped tokens, never the following
 * prose ("Pan Novák bydlí v Praze." → "Novák", not
 * "Novák bydlí v Praze.").
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";

// Deny-list / name-corpus / coreference stay off so the
// person spans asserted here come from the trigger and
// regex detectors alone (honorific triggers do not need
// the name corpus; they are pure shape + keyword rules).
const baseConfig: PipelineConfig = {
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
  enableHotwordRules: false,
  enableZoneClassification: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "person-trigger-boundary-test",
};

const detect = async (text: string): Promise<Entity[]> => {
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: baseConfig,
    gazetteerEntries: [],
    context,
  });
};

const personTexts = (entities: Entity[]): string[] =>
  entities.filter((e) => e.label === "person").map((e) => e.text);

describe("person trigger extraction stops at the name run", () => {
  test("exact regression: Pan Novák bydlí v Praze.", async () => {
    const entities = await detect("Pan Novák bydlí v Praze.");
    const persons = entities.filter((e) => e.label === "person");
    expect(persons).toHaveLength(1);
    expect(persons[0]?.text).toBe("Novák");
    expect(persons[0]?.start).toBe(4);
    expect(persons[0]?.end).toBe(9);
    expect(persons[0]?.source).toBe("trigger");
  });

  test("multi-word name: Pan Jan Novák je tady.", async () => {
    const persons = personTexts(await detect("Pan Jan Novák je tady."));
    expect(persons).toContain("Jan Novák");
    expect(persons.some((p) => p.includes("je") || p.includes("tady"))).toBe(
      false,
    );
  });

  test("post-nominal degree after a comma stays in the span", async () => {
    // The to-next-comma scan skips a comma followed by a
    // known post-nominal (Ph.D.), and the name-run rule
    // keeps the degree token (capitalized, dotted shape).
    const persons = personTexts(
      await detect("Pan Tomáš Procházka, Ph.D. souhlasí s návrhem."),
    );
    expect(persons).toContain("Tomáš Procházka, Ph.D.");
    expect(persons.some((p) => p.includes("souhlasí"))).toBe(false);
  });

  test("titled name with degree is handled by the regex detector", async () => {
    // "Ing." is a title prefix, not a trigger; the titled-
    // person regex captures the name with its degrees and
    // never crosses into the following verb.
    const persons = personTexts(
      await detect("Ing. Tomáš Procházka, Ph.D. souhlasí."),
    );
    expect(persons).toContain("Ing. Tomáš Procházka, Ph.D.");
    expect(persons.some((p) => p.includes("souhlasí"))).toBe(false);
  });

  test("lowercase nobiliary particle stays inside the run", async () => {
    const persons = personTexts(
      await detect("Pan Hans von Bülow souhlasí s návrhem."),
    );
    expect(persons).toContain("Hans von Bülow");
    expect(persons.some((p) => p.includes("souhlasí"))).toBe(false);
  });

  test("trailing particle without a following name is excluded", async () => {
    // "von" is only admitted between capitalized tokens;
    // with lowercase prose after it, the run ends at the
    // preceding name token.
    const persons = personTexts(await detect("Pan Novák von tady odešel."));
    expect(persons).toContain("Novák");
    expect(persons.some((p) => p.includes("von"))).toBe(false);
  });

  test("digit-bearing token ends the run", async () => {
    const persons = personTexts(await detect("Pan Novák 12345 Praha."));
    expect(persons).toContain("Novák");
    expect(persons.some((p) => /\d/.test(p))).toBe(false);
  });

  test("English honorific does not absorb following prose", async () => {
    const entities = await detect("Mr Smith lives in London.");
    const persons = entities.filter((e) => e.label === "person");
    expect(persons.length).toBeGreaterThan(0);
    for (const p of persons) {
      expect(p.text.endsWith("Smith")).toBe(true);
      expect(p.text.includes("lives")).toBe(false);
    }
  });

  test("legal-form capture stays greedy and reclassifies", async () => {
    // A person-labeled trigger whose value carries a legal
    // form suffix must keep the suffix so the organization
    // reclassification still fires; the name-run trim must
    // not apply to it. Legal-forms and regex detectors are
    // off so the asserted entity comes from the trigger.
    const context = createPipelineContext();
    const entities = await runPipeline({
      fullText: "jednatelem Novák Partners s.r.o. na základě plné moci.",
      config: { ...baseConfig, enableRegex: false, enableLegalForms: false },
      gazetteerEntries: [],
      context,
    });
    const org = entities.find(
      (e) => e.label === "organization" && e.source === "trigger",
    );
    expect(org).toBeDefined();
    expect(org?.text).toContain("s.r.o.");
  });

  test("comma still terminates the value as before", async () => {
    const persons = personTexts(
      await detect("jednatelem Janem Novákem, bytem Praha."),
    );
    expect(persons).toContain("Janem Novákem");
  });

  test("apostrophe-attached particle stays in the run", async () => {
    const persons = personTexts(await detect("Pan Jean d'Arc přijel pozdě."));
    expect(persons).toContain("Jean d'Arc");
  });

  test("Portuguese surname particles are not truncated", async () => {
    const persons = personTexts(
      await detect("Pan João dos Santos přijel pozdě."),
    );
    expect(persons).toContain("João dos Santos");
  });
});
