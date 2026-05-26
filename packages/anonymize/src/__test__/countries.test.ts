/**
 * Country detector: canonical CLDR names, curated
 * aliases, and ISO 3166-1 alpha-3 codes should all
 * be flagged with the "country" label. Bare alpha-2
 * codes ("US", "GB") must NOT be flagged — too many
 * false positives ("IT department", "OR" etc.).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  runPipeline,
} from "../index";
import type { Entity, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const baseConfig: Omit<PipelineConfig, "dictionaries"> = {
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
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "countries-test",
};

const detect = async (
  text: string,
  overrides: Partial<PipelineConfig> = {},
): Promise<Entity[]> => {
  const dictionaries = await loadTestDictionaries();
  const context = createPipelineContext();
  return runPipeline({
    fullText: text,
    config: { ...baseConfig, dictionaries, ...overrides },
    gazetteerEntries: [],
    context,
  });
};

const countries = (entities: Entity[]) =>
  entities.filter((e) => e.label === "country").map((e) => e.text);

describe("country detector", () => {
  test("canonical English names get flagged", async () => {
    const text =
      "The agreement is governed by the laws of the United States " +
      "and the United Kingdom. Offices are located in Japan and Germany.";
    const found = countries(await detect(text));
    expect(found).toContain("United States");
    expect(found).toContain("United Kingdom");
    expect(found).toContain("Japan");
    expect(found).toContain("Germany");
  });

  test("curated aliases (UK, USA, Czechia, DRC) get flagged", async () => {
    const text = "Operations span the UK, the USA, Czechia, and the DRC.";
    const found = countries(await detect(text));
    expect(found).toContain("UK");
    expect(found).toContain("USA");
    expect(found).toContain("Czechia");
    expect(found).toContain("DRC");
  });

  test("alpha-3 codes are NOT flagged (collide with common words)", async () => {
    // "AND" (Andorra) would match every English "and"; "ARE"
    // (UAE) every "are". Detector intentionally excludes
    // alpha-3 codes because the unified literal search runs
    // case-insensitive. "USA" is recovered via the curated
    // aliases list.
    const text = "AND, ARE, CAN, PER are common words.";
    const found = countries(await detect(text));
    expect(found).not.toContain("AND");
    expect(found).not.toContain("ARE");
    expect(found).not.toContain("CAN");
    expect(found).not.toContain("PER");
  });

  test("bare alpha-2 codes (US, GB, IT) are NOT flagged", async () => {
    // Two-letter codes collide with English prose ("IT department",
    // "OR", "AT&T", US/UK as adjectives in headlines). Detector
    // intentionally excludes them.
    const text = "The IT department is in the US office.";
    const found = countries(await detect(text));
    expect(found).not.toContain("US");
    expect(found).not.toContain("IT");
  });

  test("non-English canonical names get flagged", async () => {
    // CLDR canonical nominative forms (Czech is heavily
    // inflected; only the nominative is in the gazetteer).
    const text = "Spojené státy a Německo podepsaly smlouvu.";
    const found = countries(await detect(text));
    expect(found).toContain("Spojené státy");
    expect(found).toContain("Německo");
  });

  test("country names participating in compound phrases still resolve to country", async () => {
    // "Paul Newman and Gary Oldman working in Apple, Inc." — verbs
    // should pass through; persons and orgs caught by other detectors;
    // country detector should leave 'working in' alone.
    const text =
      "Paul Newman and Gary Oldman working in Apple, Inc., based in " +
      "the United States.";
    const entities = await detect(text);
    const found = countries(entities);
    expect(found).toContain("United States");
    // Sanity: "working" / "in" never become entities.
    const hits = entities.map((e) => e.text.toLowerCase());
    expect(hits).not.toContain("working");
    expect(hits).not.toContain("working in");
  });

  test("enableCountries: false disables country detection across all sources", async () => {
    // The flag must zero out country redaction end-to-end, not just
    // the new country slice in build-unified-search. The legacy
    // countries/translations deny-list dictionary is still loaded
    // (it ships Czech declensions the CLDR canonicals don't carry),
    // so the deny-list builder needs its own gate too — the test
    // exercises both paths by mixing English, German, and Polish
    // names alongside CS declined forms.
    const text =
      "Operations span Japan, Brazil, Mexico, Německo, Hiszpania, and České republiky.";
    const entities = await detect(text, { enableCountries: false });
    expect(entities.filter((e) => e.label === "country")).toEqual([]);
  });

  test("common-word CLDR forms (Man, Island, Indie) are NOT flagged", async () => {
    // "Man" is Norwegian for Isle of Man; "Island" is
    // Icelandic for Iceland (also de/da/no/sv); "Indie"
    // is the Czech/Polish form for India and collides with
    // the English adjective. All blocked because every
    // English "man" / "island" / "indie" would otherwise
    // emit a country entity.
    const text =
      "The man signed the deed on the island site for our indie label.";
    const found = countries(await detect(text));
    expect(found).not.toContain("man");
    expect(found).not.toContain("Man");
    expect(found).not.toContain("island");
    expect(found).not.toContain("Island");
    expect(found).not.toContain("indie");
    expect(found).not.toContain("Indie");
  });

  test("lowercase common-noun homographs are NOT flagged", async () => {
    // The literal-search slice is case-insensitive, so without a
    // proper-noun-start filter `turkey` the bird, `china` the
    // porcelain, and `jordan` the basketball player would all
    // match country aliases.
    const text =
      "We had turkey for dinner and packed it in china before " +
      "watching Jordan play.";
    const found = countries(await detect(text));
    expect(found).not.toContain("turkey");
    expect(found).not.toContain("china");
    expect(found).not.toContain("jordan");
    // Proper-noun "Jordan" (capitalized) can still match Jordan
    // the country — the basketball reference is one example of
    // why the same-span person rule above matters.
  });

  test("en-dash CLDR forms match against normalised input", async () => {
    // CLDR ships names like "Kongo – Kinshasa" (cs/CD) and
    // "Hongkong – ZAO Číny" (cs/HK) with U+2013 en-dashes.
    // The unified literal search runs against
    // normalizeForSearch(fullText), which rewrites en-/em-
    // dashes to ASCII hyphens, so the country patterns must
    // be normalised before registration or those names are
    // silently missed in any real input.
    const text = "Účastníci jsou z Kongo – Kinshasa a Hongkong – ZAO Číny.";
    const found = countries(await detect(text));
    expect(found.some((s) => s.toLowerCase().includes("kongo"))).toBe(true);
    expect(found.some((s) => s.toLowerCase().includes("hongkong"))).toBe(true);
  });

  test("'America' alone is NOT flagged (continent vs country)", async () => {
    // "North America", "Latin America", "South America"
    // are regions, not the US. The "America" alias was
    // removed; full "United States of America" still matches.
    const text = "North America and South America host most of our offices.";
    const found = countries(await detect(text));
    expect(found).not.toContain("America");
  });

  test("country token contained in a person span loses to the person", async () => {
    // "Chad", "Georgia", "Jordan" are first names AND
    // countries. When a longer person span contains the
    // country token, the person wins.
    const text =
      "Chad Smith and Georgia Williams signed on behalf of the firm.";
    const entities = await detect(text);
    const persons = entities
      .filter((e) => e.label === "person")
      .map((e) => e.text);
    const countriesFound = countries(entities);
    expect(persons.some((p) => p.includes("Smith"))).toBe(true);
    expect(persons.some((p) => p.includes("Williams"))).toBe(true);
    // The country span should be absent (or at least not
    // strip the surname).
    expect(countriesFound).not.toContain("Chad");
    expect(countriesFound).not.toContain("Georgia");
  });

  test("legacy English country names (Czech Republic, Turkey) get flagged", async () => {
    // CLDR canonicals are "Czechia" / "Türkiye"; legal text
    // overwhelmingly uses the legacy forms. Both registered
    // as aliases.
    const text =
      "The buyer is incorporated in the Czech Republic; arbitration in Turkey.";
    const found = countries(await detect(text));
    expect(found).toContain("Czech Republic");
    expect(found).toContain("Turkey");
  });

  test("straight-apostrophe variants of country names match", async () => {
    // CLDR ships only the curly apostrophe ("Côte d’Ivoire");
    // OCR / hand-typed text usually has the straight form
    // ("Côte d'Ivoire"). Both should be detected.
    const text = "Cocoa exports from Côte d'Ivoire reached record highs.";
    const found = countries(await detect(text));
    expect(found.some((s) => s.toLowerCase().includes("ivoire"))).toBe(true);
  });

  test("enableCountries flag is part of the search cache key", async () => {
    // Reusing the same PipelineContext across runs with
    // different enableCountries values must NOT bleed cached
    // country patterns into a disabled run, or hide them on
    // an enabled one.
    const dictionaries = await loadTestDictionaries();
    const context = createPipelineContext();
    const text = "Operations span Japan and Brazil.";
    const cfg = {
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
      enableZoneClassification: true,
      labels: [...DEFAULT_ENTITY_LABELS],
      workspaceId: "cache-key-test",
      dictionaries,
    };

    const enabledRun = await runPipeline({
      fullText: text,
      config: { ...cfg, enableCountries: true },
      gazetteerEntries: [],
      context,
    });
    const disabledRun = await runPipeline({
      fullText: text,
      config: { ...cfg, enableCountries: false },
      gazetteerEntries: [],
      context,
    });

    const enabledCount = enabledRun.filter(
      (e) => e.source === "country",
    ).length;
    const disabledCount = disabledRun.filter(
      (e) => e.source === "country",
    ).length;
    expect(enabledCount).toBeGreaterThan(0);
    expect(disabledCount).toBe(0);
  });

  test("same country gets the same placeholder across mentions", async () => {
    // Coreference / placeholder grouping is by label+text, so
    // identical surface forms share a placeholder. Aliases
    // resolve via the redaction map's text-key, so "USA" and
    // "United States" currently get separate placeholders —
    // that's documented behaviour, not tested here.
    const text =
      "The United States imposed sanctions. The United States later lifted them.";
    const entities = await detect(text);
    const us = entities.filter(
      (e) => e.label === "country" && e.text === "United States",
    );
    expect(us.length).toBe(2);
  });
});
