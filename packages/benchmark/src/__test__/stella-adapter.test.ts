import { describe, expect, test } from "bun:test";

import type { Dictionaries } from "@stll/anonymize";

import type { GroundTruthDocument } from "../ground-truth";
import {
  buildStllBenchmarkConfig,
  loadStllBenchmarkConfig,
  runStllAdapterWithInitializer,
} from "../adapters/stella";
import { loadCorpusDictionaries } from "../dictionaries";

const document = (
  id: string,
  language: string,
  text: string,
): GroundTruthDocument => ({
  id,
  language,
  title: id,
  text,
  entities: [],
});

describe("stella benchmark adapter language scoping", () => {
  test("an English corpus builds and reuses only an English pipeline", async () => {
    const builtLanguages: string[] = [];
    const processedLanguages: string[] = [];
    const docs = [
      document("en-1", "en", "first"),
      document("en-2", "EN", "second"),
    ];

    const outcome = await runStllAdapterWithInitializer(
      docs,
      async () => async (language) => {
        builtLanguages.push(language);
        return {
          redactText: (text) => {
            processedLanguages.push(`${language}:${text}`);
            return { resolvedEntities: [] };
          },
        };
      },
    );

    expect(outcome.status).toBe("ok");
    expect(builtLanguages).toEqual(["en"]);
    expect(processedLanguages).toEqual([
      "en:first",
      "en:second",
      "en:first",
      "en:second",
    ]);
  });

  test("a mixed corpus builds separate pipelines in deterministic order", async () => {
    const builtLanguages: string[] = [];
    const processedLanguages: string[] = [];
    const docs = [
      document("de-1", "de", "eins"),
      document("en-1", "en", "one"),
      document("de-2", "DE", "zwei"),
    ];

    await runStllAdapterWithInitializer(docs, async () => async (language) => {
      builtLanguages.push(language);
      return {
        redactText: (text) => {
          processedLanguages.push(`${language}:${text}`);
          return { resolvedEntities: [] };
        },
      };
    });

    expect(builtLanguages).toEqual(["de", "en"]);
    expect(processedLanguages).toEqual([
      "de:eins",
      "en:one",
      "de:zwei",
      "de:eins",
      "en:one",
      "de:zwei",
    ]);
  });

  test("each pipeline config carries one language rather than a union", () => {
    const dictionaries: Dictionaries = {};

    const english = buildStllBenchmarkConfig(dictionaries, "en");
    const german = buildStllBenchmarkConfig(dictionaries, "de");

    expect(english.language).toBe("en");
    expect(english.languages).toBeUndefined();
    expect(german.language).toBe("de");
    expect(german.languages).toBeUndefined();
  });

  test("pipeline configs receive only the requested language's names", async () => {
    const [englishConfig, germanConfig, cachedEnglish] = await Promise.all([
      loadStllBenchmarkConfig("en"),
      loadStllBenchmarkConfig("de"),
      loadCorpusDictionaries("EN"),
    ]);
    const english = englishConfig.dictionaries;
    const german = germanConfig.dictionaries;
    if (english === undefined || german === undefined) {
      throw new Error("benchmark pipeline config omitted dictionaries");
    }

    expect(Object.keys(english.firstNames ?? {})).toEqual(["en"]);
    expect(Object.keys(english.surnames ?? {})).toEqual(["en"]);
    expect(Object.keys(german.firstNames ?? {})).toEqual(["de"]);
    expect(Object.keys(german.surnames ?? {})).toEqual(["de"]);
    expect(cachedEnglish).toBe(english);
    expect(
      Object.values(english.denyListMeta ?? {}).every(
        (meta) => meta.country === null && meta.category !== "Names",
      ),
    ).toBeTrue();
    expect(english.citiesByCountry).toEqual({});
  });
});
