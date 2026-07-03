/**
 * Regression: a single PipelineContext reused across DIFFERENT configs must not
 * leak config-dependent bundle artifacts between pipelines.
 *
 * The name corpus is cached on the context. It is keyed by the selected name
 * languages, but the loaded corpus also depends on the injected `dictionaries`.
 * A first config that builds the corpus WITHOUT dictionaries (name corpus
 * disabled / no dictionaries) used to pin `ctx.nameCorpus` under the language
 * key "*"; a later full config that shares the SAME context (also language key
 * "*", but WITH dictionaries) would reuse the dictionary-less corpus and lose
 * person detection for dictionary-only given names (e.g. "Chad").
 *
 * Distinct thresholds keep both configs off the process-global prepared-package
 * cache so each pipeline is genuinely built against the shared context here
 * (otherwise a cache hit from another test file would mask the poisoning).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { createPipelineContext } from "../context";
import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

// Config that builds the name corpus WITHOUT dictionaries (name corpus and
// deny list disabled), mirroring the comma-party-names style config.
const CORPUS_LESS_CONFIG: PipelineConfig = {
  threshold: 0.31,
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
  workspaceId: "context-cache-poison",
};

describe("shared PipelineContext across different configs", () => {
  test("dictionary-only given names still detected after a corpus-less config ran on the same context", async () => {
    const ctx = createPipelineContext();
    const dictionaries = await loadTestDictionaries();

    // Full config: name corpus enabled, dictionaries injected, no explicit
    // nameCorpusLanguages (so the corpus language key is "*", the same key the
    // corpus-less config pins). A distinct threshold keeps it off the shared
    // prepared-package cache.
    const fullConfig: PipelineConfig = {
      threshold: 0.32,
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
      dictionaries,
      workspaceId: "context-cache-full",
    };

    // 1. Poison: run the corpus-less config first on the shared context.
    await detectNative(
      CORPUS_LESS_CONFIG,
      "Twitter, Inc. signed the joinder.",
      {
        context: ctx,
      },
    );

    // 2. Full config on the SAME context must still see the dictionary corpus.
    // "Chad" is a dictionary-only given name and also a country; the person
    // span must win, so it must NOT be flagged as a country.
    const text =
      "Chad Smith and Georgia Williams signed on behalf of the firm.";
    const entities = await detectNative(fullConfig, text, { context: ctx });
    const persons = entities
      .filter((e) => e.label === "person")
      .map((e) => e.text);
    const countriesFound = entities
      .filter((e) => e.label === "country")
      .map((e) => e.text);

    expect(persons.some((p) => p.includes("Smith"))).toBe(true);
    expect(countriesFound).not.toContain("Chad");
  });
});
