import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  createNativePipelineFromConfig,
  preparePipelineSearch,
  prepareNativePipelinePackage,
  redactText,
  runPipeline,
} from "../index";
import {
  buildNativeStaticSearchBundle,
  buildUnifiedSearch,
} from "../build-unified-search";
import {
  REGEX_META,
  REGEX_PATTERNS,
  getNativeSigningClausePatterns,
  getSigningClausePatterns,
} from "../detectors/regex";
import { applyPipelineLanguageScope } from "../language-scope";
import { languageConfigMatches } from "../util/language-selection";
import type { NativeAnonymizeBinding } from "../native";
import type { Dictionaries, PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

let dictionaries: Dictionaries;
const getDictionaries = async () => {
  if (!dictionaries) dictionaries = await loadTestDictionaries();
  return dictionaries;
};

const BASE_CONFIG: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [],
  workspaceId: "test",
};

let sharedCtx: ReturnType<typeof createPipelineContext> | undefined;
const getCtx = () => {
  if (!sharedCtx) sharedCtx = createPipelineContext();
  return sharedCtx;
};

const detect = async (fullText: string, config: Partial<PipelineConfig>) =>
  runPipeline({
    fullText,
    config: {
      ...BASE_CONFIG,
      ...config,
    },
    gazetteerEntries: [],
    context: getCtx(),
  });

const createCountingNativeBinding = (version: string) => {
  let compressedPrepare = 0;
  let rawPrepare = 0;
  let fromPackage = 0;
  const binding = {
    normalizeForSearch: (text: string) => text,
    nativePackageVersion: () => version,
    NativePreparedSearch: {
      fromConfigJsonBytes: () => {
        throw new Error("native package cache test should use package bytes");
      },
      fromPreparedPackageBytes: () => {
        fromPackage += 1;
        return {
          prepareDiagnosticsJson: () => JSON.stringify({ events: [] }),
          redactStaticEntities: (fullText: string) => ({
            resolvedEntities: [],
            redaction: {
              redactedText: fullText,
              redactionMap: [],
              operatorMap: [],
              entityCount: 0,
            },
          }),
        };
      },
    },
    prepareStaticSearchPackageBytes: (configJson: Uint8Array) => {
      rawPrepare += 1;
      return new Uint8Array([rawPrepare, configJson.byteLength % 256]);
    },
    prepareStaticSearchCompressedPackageBytes: (configJson: Uint8Array) => {
      compressedPrepare += 1;
      return new Uint8Array([compressedPrepare, configJson.byteLength % 256]);
    },
  } satisfies NativeAnonymizeBinding;

  return {
    binding,
    counts: () => ({
      compressedPrepare,
      fromPackage,
      rawPrepare,
    }),
  };
};

describe("pipeline config semantics", () => {
  test("content language derives dictionary scopes", () => {
    expect(
      applyPipelineLanguageScope({
        ...BASE_CONFIG,
        language: "en-US",
      }),
    ).toMatchObject({
      nameCorpusLanguages: ["en"],
      denyListCountries: ["US", "GB", "CA", "AU", "IE"],
    });
  });

  test("explicit dictionary scopes override content language", () => {
    expect(
      applyPipelineLanguageScope({
        ...BASE_CONFIG,
        language: "en",
        denyListCountries: ["CZ"],
        nameCorpusLanguages: ["cs"],
      }),
    ).toMatchObject({
      nameCorpusLanguages: ["cs"],
      denyListCountries: ["CZ"],
    });
  });

  test("language config matching keeps regional hints precise", () => {
    expect(languageConfigMatches("en", ["en-US"])).toBe(true);
    expect(languageConfigMatches("pt", ["pt-BR"])).toBe(true);
    expect(languageConfigMatches("pt-br", ["pt-BR"])).toBe(true);
    expect(languageConfigMatches("pt-br", ["pt-PT"])).toBe(false);
    expect(languageConfigMatches("en", [""])).toBe(true);
  });

  test("empty labels do not suppress deterministic detectors", async () => {
    const entities = await detect("Datum narození: 2024-01-02", {
      enableRegex: true,
      labels: [],
    });
    expect(entities.some((entity) => entity.label === "date")).toBe(true);
  });

  test("labels filter applies to deterministic detectors", async () => {
    const entities = await detect("Datum narození: 2024-01-02", {
      enableRegex: true,
      labels: ["person"],
    });
    expect(entities).toHaveLength(0);
  });

  test("labels filter prunes built-in regex patterns before search build", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["email address", "registration number"],
      },
      [],
      createPipelineContext(),
    );
    const regexCount = search.slices.regex.end - search.slices.regex.start;
    const expected = REGEX_META.filter(
      (meta) =>
        meta.label === "email address" || meta.label === "registration number",
    ).length;

    expect(regexCount).toBe(expected);
  });

  test("native config carries final label and threshold filters", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        enableConfidenceBoost: true,
        labels: ["person"],
        threshold: 0.93,
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.allowed_labels).toEqual(["person"]);
    expect(search.nativeStaticConfig.threshold).toBe(0.93);
    expect(search.nativeStaticConfig.confidence_boost).toBe(true);
    expect(search.nativeStaticConfig.regex_options.regex_artifact_policy).toBe(
      "omit",
    );
    expect(
      search.nativeStaticConfig.custom_regex_options.regex_artifact_policy,
    ).toBe("omit");
  });

  test("native config carries false-positive filters without deny-list matching", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableDenyList: false,
        enableRegex: true,
        labels: ["organization"],
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.deny_list_data).toBeUndefined();
    expect(
      search.nativeStaticConfig.false_positive_filters?.document_heading_words,
    ).toContain("schedule");
  });

  test("native config carries hotword rule metadata", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        enableHotwordRules: true,
        labels: ["date of birth"],
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.allowed_labels).toEqual(["date of birth"]);
    expect(search.nativeStaticConfig.slices.hotwords).toEqual({
      start: search.nativeStaticConfig.slices.hotwords?.start ?? 0,
      end: search.nativeStaticConfig.slices.hotwords?.start ?? 0,
    });
    expect(
      search.nativeStaticConfig.hotword_data?.rules.some((rule) =>
        rule.hotwords.includes("born"),
      ),
    ).toBe(true);
    expect(
      search.nativeStaticConfig.literal_patterns.some(
        (pattern) => pattern.pattern === "born",
      ),
    ).toBe(false);
    expect(
      search.nativeStaticConfig.hotword_data?.pattern_rule_indices,
    ).toEqual([]);
  });

  test("native signing-place patterns match TypeScript signing patterns", async () => {
    const [tsPatterns, nativePatterns] = await Promise.all([
      getSigningClausePatterns(),
      getNativeSigningClausePatterns(),
    ]);

    expect(nativePatterns).toEqual(tsPatterns);
    expect(nativePatterns.some((pattern) => pattern.includes("Signed"))).toBe(
      true,
    );
    expect(nativePatterns.some((pattern) => pattern.includes("À"))).toBe(true);
  });

  test("content language scopes native signing-place patterns", async () => {
    const [tsPatterns, nativePatterns] = await Promise.all([
      getSigningClausePatterns(["en-US"]),
      getNativeSigningClausePatterns(["en-US"]),
    ]);
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        enableZoneClassification: true,
        labels: ["address"],
        language: "en-US",
      },
      [],
      createPipelineContext(),
    );
    const regexPatterns = search.nativeStaticConfig.regex_patterns.map(
      (pattern) => pattern.pattern,
    );

    expect(nativePatterns).toEqual(tsPatterns);
    expect(nativePatterns).toHaveLength(1);
    expect(nativePatterns.at(0)).toContain("Signed");
    expect(regexPatterns.some((pattern) => pattern.includes("Signed"))).toBe(
      true,
    );
    expect(regexPatterns.some((pattern) => pattern.includes("Fatto"))).toBe(
      false,
    );
    expect(search.nativeStaticConfig.zone_data?.signing_clauses).toHaveLength(
      1,
    );
  });

  test("native pipeline package context cache is scoped by dictionary identity", async () => {
    const { binding, counts } = createCountingNativeBinding(
      "native-cache-context-dictionaries",
    );
    const context = createPipelineContext();
    const cacheDictionaries = {
      firstNames: {
        en: ["Ada"],
      },
    } satisfies Dictionaries;
    const config = {
      ...BASE_CONFIG,
      dictionaries: cacheDictionaries,
      enableCountries: false,
      labels: ["person"],
    };

    await prepareNativePipelinePackage({ binding, config, context });
    await prepareNativePipelinePackage({
      binding,
      config: {
        ...config,
        dictionaries: { ...cacheDictionaries },
      },
      context,
    });

    expect(counts().compressedPrepare).toBe(2);
  });

  test("native config carries coreference definition data", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableCoreference: true,
        enableRegex: true,
        labels: ["organization"],
      },
      [],
      createPipelineContext(),
    );

    expect(
      search.nativeStaticConfig.coreference_data?.definition_patterns.length,
    ).toBeGreaterThan(0);
    expect(
      search.nativeStaticConfig.coreference_data?.role_stop_terms,
    ).toContain("seller");
    expect(
      search.nativeStaticConfig.coreference_data?.legal_form_aliases,
    ).toContain("LLC");
    expect(
      search.nativeStaticConfig.coreference_data?.legal_form_aliases,
    ).toContain("Kft.");
    expect(
      search.nativeStaticConfig.coreference_data?.organization_suffixes,
    ).toContain("LLC");
    expect(
      search.nativeStaticConfig.coreference_data?.organization_suffixes,
    ).not.toContain("Kft.");
    expect(
      search.nativeStaticConfig.coreference_data?.organization_determiners,
    ).toContain("the\\s+(?:company|corporation|firm)");
  });

  test("content language scopes native coreference data", async () => {
    const base = {
      ...BASE_CONFIG,
      enableCoreference: true,
      labels: ["organization"],
    };
    const unscoped = await buildUnifiedSearch(
      base,
      [],
      createPipelineContext(),
    );
    const scoped = await buildUnifiedSearch(
      { ...base, language: "en-US" },
      [],
      createPipelineContext(),
    );

    const unscopedPatterns =
      unscoped.nativeStaticConfig.coreference_data?.definition_patterns ?? [];
    const scopedPatterns =
      scoped.nativeStaticConfig.coreference_data?.definition_patterns.map(
        (pattern) => pattern.pattern,
      ) ?? [];

    expect(scopedPatterns.length).toBeLessThan(unscopedPatterns.length);
    expect(
      scopedPatterns.some((pattern) => pattern.includes("hereinafter")),
    ).toBe(true);
    expect(scopedPatterns.some((pattern) => pattern.includes("dále"))).toBe(
      false,
    );
    expect(
      scoped.nativeStaticConfig.coreference_data?.organization_determiners,
    ).toEqual(["the\\s+(?:company|corporation|firm)"]);
  });

  test("native config carries zone classifier data", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableZoneClassification: true,
        labels: ["person"],
      },
      [],
      createPipelineContext(),
    );

    expect(
      search.nativeStaticConfig.zone_data?.section_heading_patterns.length,
    ).toBeGreaterThan(0);
    expect(
      search.nativeStaticConfig.zone_data?.section_heading_patterns.some(
        ({ pattern }) => pattern.includes("Article"),
      ),
    ).toBe(true);
    expect(
      search.nativeStaticConfig.zone_data?.signing_clauses.length,
    ).toBeGreaterThan(0);
  });

  test("native trigger config carries legal suffix data without legal-form search", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableTriggerPhrases: true,
        enableLegalForms: false,
        labels: ["organization"],
      },
      [],
      createPipelineContext(),
    );

    const legalFormsSlice = search.nativeStaticConfig.slices.legal_forms;
    expect(legalFormsSlice).toBeDefined();
    expect(legalFormsSlice?.end).toBe(legalFormsSlice?.start);
    expect(
      search.nativeStaticConfig.legal_form_data?.suffixes.length,
    ).toBeGreaterThan(0);
    expect(
      search.nativeStaticConfig.trigger_data?.rules.length,
    ).toBeGreaterThan(0);
  });

  test("native trigger config carries language-scoped support labels", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableTriggerPhrases: true,
        labels: ["phone number", "registration number", "matter id"],
        language: "en",
      },
      [],
      createPipelineContext(),
    );

    expect(
      search.nativeStaticConfig.trigger_data?.phone_extension_labels,
    ).toContain("ext");
    expect(search.nativeStaticConfig.trigger_data?.number_markers).toContain(
      "no",
    );
    expect(search.nativeStaticConfig.trigger_data?.number_labels).toContain(
      "no.",
    );
    expect(search.nativeStaticConfig.trigger_data?.number_labels).toContain(
      "№",
    );
  });

  test("native signature config is packaged without content-language drift", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        labels: ["person"],
        language: "cs",
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.signature_data?.labels).toContain("name");
    expect(search.nativeStaticConfig.signature_data?.witness_phrases).toContain(
      "in witness whereof",
    );
    expect(
      search.nativeStaticConfig.signature_data?.organization_suffixes,
    ).toContain("inc.");
    expect(
      search.nativeStaticConfig.signature_data?.image_stub_prefixes,
    ).toContain("[logo");
  });

  test("native config carries stdnum validator metadata", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["national identification number"],
      },
      [],
      createPipelineContext(),
    );

    const patternIndex = search.nativeStaticConfig.regex_meta.findIndex(
      (entry) => entry.validator_id === "cn.ric",
    );
    expect(patternIndex).toBeGreaterThanOrEqual(0);
    const meta = search.nativeStaticConfig.regex_meta.at(patternIndex);
    expect(meta).toMatchObject({
      label: "national identification number",
      requires_validation: true,
      validator_id: "cn.ric",
    });
    expect(
      search.nativeStaticConfig.regex_meta.filter(
        (entry) => entry.requires_validation === true && !entry.validator_id,
      ),
    ).toEqual([]);
  });

  test("native config keeps generated stdnum regexes artifact-free", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["tax identification number", "national identification number"],
      },
      [],
      createPipelineContext(),
    );
    const patternForValidator = (validatorId: string) => {
      const index = search.nativeStaticConfig.regex_meta.findIndex(
        (entry) => entry.validator_id === validatorId,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const pattern = search.nativeStaticConfig.regex_patterns.at(index);
      if (pattern?.kind !== "regex") {
        throw new Error(`Missing regex pattern for ${validatorId}`);
      }
      return pattern;
    };

    expect(patternForValidator("fr.tva")).toMatchObject({
      lazy: true,
      prefilter_any: ["FR"],
      prefilter_case_insensitive: false,
      prepared_artifact_policy: "omit",
    });
    expect(patternForValidator("lv.vat")).toMatchObject({
      lazy: true,
      prefilter_any: ["LV"],
      prepared_artifact_policy: "omit",
    });
    expect(patternForValidator("lt.asmens")).not.toHaveProperty(
      "prepared_artifact_policy",
    );

    const contextValidatorIndex =
      search.nativeStaticConfig.regex_meta.findIndex(
        (entry) => entry.validator_id === "gb.nhs",
      );
    expect(contextValidatorIndex).toBeGreaterThanOrEqual(0);
    expect(
      search.nativeStaticConfig.regex_patterns.at(contextValidatorIndex),
    ).toMatchObject({
      lazy: true,
      prepared_artifact_policy: "omit",
    });
  });

  test("native config carries static regex prefilter metadata", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["email address", "registration number"],
      },
      [],
      createPipelineContext(),
    );

    expect(REGEX_PATTERNS.every((pattern) => typeof pattern === "string")).toBe(
      true,
    );
    const emailPattern = search.nativeStaticConfig.regex_patterns.find(
      (pattern) =>
        pattern.kind === "regex" &&
        pattern.pattern === "\\b[\\w.+\\-]+@[\\w\\-]+(?:\\.[\\w\\-]+)+\\b",
    );

    expect(emailPattern).toMatchObject({
      lazy: true,
      prefilter_any: ["@"],
      prefilter_case_insensitive: false,
    });

    const czechRegistryPattern = search.nativeStaticConfig.regex_patterns.find(
      (pattern) =>
        pattern.kind === "regex" && pattern.pattern.includes("[Oo][Dd][Dd]"),
    );

    expect(czechRegistryPattern).toMatchObject({
      lazy: true,
      prefilter_any: ["oddíl", "vložka"],
      prefilter_case_insensitive: true,
    });
  });

  test("native config carries windowed regex prefilters", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["address", "passport number"],
      },
      [],
      createPipelineContext(),
    );

    const spanishPostalPattern = search.nativeStaticConfig.regex_patterns.find(
      (pattern) =>
        pattern.kind === "regex" && pattern.pattern.includes("[Cc][óo]digo"),
    );
    const passportPattern = search.nativeStaticConfig.regex_patterns.find(
      (pattern) =>
        pattern.kind === "regex" && pattern.pattern.includes("passports?"),
    );

    expect(spanishPostalPattern).toMatchObject({
      lazy: true,
      prefilter_window_bytes: 160,
      prepared_artifact_policy: "omit",
    });
    expect(passportPattern).toMatchObject({
      lazy: true,
      prefilter_window_bytes: 160,
      prepared_artifact_policy: "omit",
    });
  });

  test("native config splits percent regex prefilters", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        labels: ["monetary amount"],
      },
      [],
      createPipelineContext(),
    );

    const percentPatterns = search.nativeStaticConfig.regex_patterns.filter(
      (pattern, index) =>
        pattern.kind === "regex" &&
        search.nativeStaticConfig.regex_meta[index]?.label ===
          "monetary amount" &&
        pattern.pattern.includes("%"),
    );
    const writtenPercentPattern = percentPatterns.find((pattern) =>
      pattern.pattern.includes("one hundred"),
    );
    const numericPercentPattern = percentPatterns.find(
      (pattern) => !pattern.pattern.includes("one hundred"),
    );

    expect(writtenPercentPattern).toMatchObject({
      lazy: true,
      prefilter_any: ["percent"],
      prefilter_case_insensitive: true,
      prefilter_window_bytes: 160,
    });
    expect(numericPercentPattern).toMatchObject({
      lazy: true,
      prefilter_any: ["%"],
      prefilter_case_insensitive: false,
    });
  });

  test("native trigger config carries currency terms and monetary extension data", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: false,
        enableTriggerPhrases: true,
        labels: [],
      },
      [],
      createPipelineContext(),
    );

    expect(
      search.nativeStaticConfig.trigger_data?.sentence_terminal_currency_terms
        .length,
    ).toBeGreaterThan(0);
    expect(search.nativeStaticConfig.monetary_data).toBeDefined();
  });

  test("native date data gates year words on trigger phrases", async () => {
    const regexOnly = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        enableTriggerPhrases: false,
        labels: ["date"],
      },
      [],
      createPipelineContext(),
    );
    const withTriggers = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableRegex: true,
        enableTriggerPhrases: true,
        labels: ["date"],
      },
      [],
      createPipelineContext(),
    );

    expect(
      Object.values(
        regexOnly.nativeStaticConfig.date_data?.year_words_by_language ?? {},
      ).flat(),
    ).toEqual([]);
    expect(
      Object.values(
        withTriggers.nativeStaticConfig.date_data?.year_words_by_language ?? {},
      ).flat().length,
    ).toBeGreaterThan(0);
  });

  test("content language scopes native date data", async () => {
    const base = {
      ...BASE_CONFIG,
      enableRegex: true,
      enableTriggerPhrases: true,
      labels: ["date"],
    };
    const unscoped = await buildNativeStaticSearchBundle(
      base,
      [],
      createPipelineContext(),
    );
    const scoped = await buildNativeStaticSearchBundle(
      { ...base, language: "en-US" },
      [],
      createPipelineContext(),
    );

    const unscopedMonthLanguages = Object.keys(
      unscoped.nativeStaticConfig.date_data?.month_names_by_language ?? {},
    );
    const scopedMonthLanguages = Object.keys(
      scoped.nativeStaticConfig.date_data?.month_names_by_language ?? {},
    );
    const scopedYearLanguages = Object.keys(
      scoped.nativeStaticConfig.date_data?.year_words_by_language ?? {},
    );

    expect(unscopedMonthLanguages.length).toBeGreaterThan(
      scopedMonthLanguages.length,
    );
    expect(scopedMonthLanguages).toEqual(["en"]);
    expect(scopedYearLanguages).toEqual(["en"]);
  });

  test("content language scopes trigger data", async () => {
    const base = {
      ...BASE_CONFIG,
      enableTriggerPhrases: true,
      labels: [],
    };
    const unscoped = await buildNativeStaticSearchBundle(
      base,
      [],
      createPipelineContext(),
    );
    const scoped = await buildNativeStaticSearchBundle(
      { ...base, language: "en-US" },
      [],
      createPipelineContext(),
    );

    const unscopedTriggers =
      unscoped.nativeStaticConfig.trigger_data?.rules ?? [];
    const scopedTriggers =
      scoped.nativeStaticConfig.trigger_data?.rules.map((rule) =>
        rule.trigger.toLowerCase(),
      ) ?? [];

    expect(scopedTriggers.length).toBeLessThan(unscopedTriggers.length);
    expect(scopedTriggers).toContain("represented by");
    expect(scopedTriggers).toContain("year");
    expect(scopedTriggers).not.toContain("zastoupen");
    expect(scopedTriggers).not.toContain("rok");
  });

  test("content language scopes deny-list search build", async () => {
    const testDictionaries = await getDictionaries();
    const config = {
      ...BASE_CONFIG,
      dictionaries: testDictionaries,
      enableDenyList: true,
      enableNameCorpus: true,
      labels: ["address", "person"],
    };

    const unscoped = await buildUnifiedSearch(
      config,
      [],
      createPipelineContext(),
    );
    const scoped = await buildUnifiedSearch(
      { ...config, language: "en" },
      [],
      createPipelineContext(),
    );

    expect(
      scoped.slices.denyList.end - scoped.slices.denyList.start,
    ).toBeLessThan(
      unscoped.slices.denyList.end - unscoped.slices.denyList.start,
    );
  });

  test("native config keeps alphanumeric custom deny-list overlays compact", async () => {
    const testDictionaries = await getDictionaries();
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        dictionaries: testDictionaries,
        enableDenyList: true,
        customDenyList: [
          {
            value: "Widget X",
            label: "organization",
          },
        ],
        labels: ["organization"],
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.literal_patterns_from_deny_list_data).toBe(
      true,
    );
    expect(search.nativeStaticConfig.literal_patterns).toHaveLength(0);
    expect(search.nativeStaticConfig.deny_list_data?.originals).toContain(
      "Widget X",
    );
    expect(
      search.nativeStaticConfig.deny_list_data?.originals.length ?? 0,
    ).toBeGreaterThan(1);
  });

  test("native config inlines punctuation-edged custom deny-list overlays", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableDenyList: true,
        customDenyList: [
          {
            value: ".env",
            label: "file",
          },
        ],
        labels: ["file"],
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.literal_patterns_from_deny_list_data).toBe(
      false,
    );
    expect(search.nativeStaticConfig.literal_patterns).toEqual([
      expect.objectContaining({
        kind: "literal-with-options",
        pattern: ".env",
        whole_words: false,
      }),
    ]);
  });

  test("native config serializes gazetteer metadata with Rust field names", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableGazetteer: true,
        labels: ["organization"],
      },
      [
        {
          id: "gazetteer-acme",
          canonical: "Acme",
          label: "organization",
          variants: [],
          workspaceId: "test",
          createdAt: 0,
          source: "manual",
        },
      ],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.gazetteer_data).toEqual({
      labels: ["organization", "organization"],
      is_fuzzy: [false, true],
    });
    expect(search.nativeStaticConfig.literal_options.fuzzy_whole_words).toBe(
      false,
    );
    expect(
      Object.hasOwn(search.nativeStaticConfig.gazetteer_data ?? {}, "isFuzzy"),
    ).toBe(false);
  });

  test("preparePipelineSearch reuses the context search cache", async () => {
    const context = createPipelineContext();
    const config = {
      ...BASE_CONFIG,
      enableRegex: true,
      labels: ["email address"],
    };
    const first = await preparePipelineSearch({ config, context });
    const second = await preparePipelineSearch({ config, context });

    expect(second).toBe(first);
  });

  test("preparePipelineSearch cache keys content language", async () => {
    const context = createPipelineContext();
    const baseConfig = {
      ...BASE_CONFIG,
      enableTriggerPhrases: true,
      labels: ["person"],
    };

    const english = await preparePipelineSearch({
      config: { ...baseConfig, language: "en" },
      context,
    });
    const czech = await preparePipelineSearch({
      config: { ...baseConfig, language: "cs" },
      context,
    });

    const englishTriggers =
      english.nativeStaticConfig.trigger_data?.rules.map((rule) =>
        rule.trigger.toLowerCase(),
      ) ?? [];
    const czechTriggers =
      czech.nativeStaticConfig.trigger_data?.rules.map((rule) =>
        rule.trigger.toLowerCase(),
      ) ?? [];

    expect(czech).not.toBe(english);
    expect(englishTriggers).toContain("represented by");
    expect(englishTriggers).not.toContain("zastoupen");
    expect(czechTriggers).toContain("zastoupen");
  });

  test("preparePipelineSearch reuses shared search across fresh contexts", async () => {
    const testDictionaries = await getDictionaries();
    const config = {
      ...BASE_CONFIG,
      dictionaries: testDictionaries,
      enableRegex: true,
      labels: ["email address"],
    };
    const firstContext = createPipelineContext();
    const secondContext = createPipelineContext();

    const first = await preparePipelineSearch({
      config,
      context: firstContext,
    });
    const second = await preparePipelineSearch({
      config,
      context: secondContext,
    });

    expect(second).toBe(first);
    expect(secondContext.search).toBe(first);
  });

  test("preparePipelineSearch does not share across dictionary objects", async () => {
    const testDictionaries = await getDictionaries();
    const config = {
      ...BASE_CONFIG,
      dictionaries: testDictionaries,
      enableRegex: true,
      labels: ["email address"],
    };
    const clonedConfig = {
      ...config,
      dictionaries: {
        ...testDictionaries,
      },
    };

    const first = await preparePipelineSearch({
      config,
      context: createPipelineContext(),
    });
    const second = await preparePipelineSearch({
      config: clonedConfig,
      context: createPipelineContext(),
    });

    expect(second).not.toBe(first);
  });

  test("preparePipelineSearch cache keys native redaction options", async () => {
    const context = createPipelineContext();
    const baseConfig = {
      ...BASE_CONFIG,
      enableRegex: true,
      labels: ["date of birth"],
    };

    const first = await preparePipelineSearch({
      config: {
        ...baseConfig,
        threshold: 0.5,
        enableConfidenceBoost: false,
        enableHotwordRules: false,
      },
      context,
    });
    const second = await preparePipelineSearch({
      config: {
        ...baseConfig,
        threshold: 0.93,
        enableConfidenceBoost: true,
        enableHotwordRules: true,
      },
      context,
    });

    expect(second).not.toBe(first);
    expect(second.nativeStaticConfig.threshold).toBe(0.93);
    expect(second.nativeStaticConfig.confidence_boost).toBe(true);
    expect(
      second.nativeStaticConfig.hotword_data?.rules.length,
    ).toBeGreaterThan(0);
  });

  test("native pipeline package cache reuses exact configs", async () => {
    const { binding, counts } = createCountingNativeBinding(
      "native-cache-context",
    );
    const context = createPipelineContext();
    const config = {
      ...BASE_CONFIG,
      enableCountries: false,
      labels: ["person"],
    };

    const first = await prepareNativePipelinePackage({
      binding,
      config,
      context,
    });
    first[0] = 99;
    const second = await prepareNativePipelinePackage({
      binding,
      config,
      context,
    });
    await createNativePipelineFromConfig({ binding, config, context });

    expect(counts().compressedPrepare).toBe(1);
    expect(second[0]).toBe(1);
  });

  test("native pipeline package cache is scoped by dictionary identity", async () => {
    const { binding, counts } = createCountingNativeBinding(
      "native-cache-dictionaries",
    );
    const cacheDictionaries = {
      firstNames: {
        en: ["Ada"],
      },
    } satisfies Dictionaries;
    const config = {
      ...BASE_CONFIG,
      dictionaries: cacheDictionaries,
      enableCountries: false,
      labels: ["person"],
    };

    await prepareNativePipelinePackage({
      binding,
      config,
      context: createPipelineContext(),
    });
    await prepareNativePipelinePackage({
      binding,
      config,
      context: createPipelineContext(),
    });
    await prepareNativePipelinePackage({
      binding,
      config: {
        ...config,
        dictionaries: { ...cacheDictionaries },
      },
      context: createPipelineContext(),
    });

    expect(counts().compressedPrepare).toBe(2);
  });

  test("native pipeline package cache keys caller data", async () => {
    const { binding, counts } = createCountingNativeBinding(
      "native-cache-caller-data",
    );
    const context = createPipelineContext();
    const config = {
      ...BASE_CONFIG,
      customRegexes: [
        {
          label: "matter id",
          pattern: "MAT-[0-9]+",
        },
      ],
      enableCountries: false,
      enableRegex: true,
      labels: ["matter id"],
    };

    await prepareNativePipelinePackage({ binding, config, context });
    await prepareNativePipelinePackage({
      binding,
      config: {
        ...config,
        customRegexes: [
          {
            label: "matter id",
            pattern: "REF-[0-9]+",
          },
        ],
      },
      context,
    });

    expect(counts().compressedPrepare).toBe(2);
  });

  test("native pipeline package cache keys contextual native passes", async () => {
    const { binding, counts } = createCountingNativeBinding(
      "native-cache-contextual-passes",
    );
    const context = createPipelineContext();
    const config = {
      ...BASE_CONFIG,
      enableCountries: false,
      enableCoreference: false,
      enableZoneClassification: false,
      labels: ["organization"],
    };

    await prepareNativePipelinePackage({ binding, config, context });
    await prepareNativePipelinePackage({
      binding,
      config: {
        ...config,
        enableCoreference: true,
      },
      context,
    });
    await prepareNativePipelinePackage({
      binding,
      config: {
        ...config,
        enableZoneClassification: true,
      },
      context,
    });

    expect(counts().compressedPrepare).toBe(3);
  });

  test("native pipeline package cache retries after failed build", async () => {
    let attempts = 0;
    const binding = {
      normalizeForSearch: (text: string) => text,
      nativePackageVersion: () => "native-cache-retry",
      NativePreparedSearch: {
        fromConfigJsonBytes: () => {
          throw new Error(
            "native package cache retry should use package bytes",
          );
        },
        fromPreparedPackageBytes: () => ({
          prepareDiagnosticsJson: () => JSON.stringify({ events: [] }),
          redactStaticEntities: (fullText: string) => ({
            resolvedEntities: [],
            redaction: {
              redactedText: fullText,
              redactionMap: [],
              operatorMap: [],
              entityCount: 0,
            },
          }),
        }),
      },
      prepareStaticSearchPackageBytes: () => new Uint8Array([9]),
      prepareStaticSearchCompressedPackageBytes: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("build failed");
        }
        return new Uint8Array([attempts]);
      },
    } satisfies NativeAnonymizeBinding;
    const context = createPipelineContext();
    const config = {
      ...BASE_CONFIG,
      enableCountries: false,
      labels: ["person"],
    };

    try {
      await prepareNativePipelinePackage({ binding, config, context });
      throw new Error("expected first native package build to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toBe("build failed");
    }

    const retry = await prepareNativePipelinePackage({
      binding,
      config,
      context,
    });

    expect([...retry]).toEqual([2]);
    expect(attempts).toBe(2);
  });

  test("native trigger configs carry monetary extension data", async () => {
    const search = await buildUnifiedSearch(
      {
        ...BASE_CONFIG,
        enableTriggerPhrases: true,
        labels: ["monetary amount"],
      },
      [],
      createPipelineContext(),
    );

    expect(search.nativeStaticConfig.monetary_data).toBeDefined();
    expect(
      search.nativeStaticConfig.monetary_data?.amount_words
        .written_amount_patterns.length,
    ).toBeGreaterThan(0);
  });

  test("enableLegalForms flag gates legal-form detection", async () => {
    const withFlag = await detect("Acme s.r.o.", {
      enableLegalForms: true,
      labels: ["organization"],
    });
    expect(withFlag.some((entity) => entity.label === "organization")).toBe(
      true,
    );

    const withoutFlag = await detect("Acme s.r.o.", {
      enableLegalForms: false,
      labels: ["organization"],
    });
    expect(withoutFlag).toHaveLength(0);
  });

  test("legacy configs without enableLegalForms keep legal-form detection enabled", async () => {
    const entities = await runPipeline({
      fullText: "Acme s.r.o.",
      config: {
        ...BASE_CONFIG,
        enableLegalForms: undefined,
        labels: ["organization"],
      } as unknown as PipelineConfig,
      gazetteerEntries: [],
      context: createPipelineContext(),
    });
    expect(entities.some((entity) => entity.label === "organization")).toBe(
      true,
    );
  });

  test("enableNameCorpus disables name matches in deny-list mode", async () => {
    const entities = await detect("Jan Novak", {
      enableDenyList: true,
      enableNameCorpus: false,
      denyListCountries: ["CZ"],
      labels: ["person"],
      dictionaries: await getDictionaries(),
    });
    expect(entities).toHaveLength(0);
  });

  test("enableNameCorpus keeps name matches available in deny-list mode", async () => {
    const entities = await detect("Jan Novak", {
      enableDenyList: true,
      enableNameCorpus: true,
      denyListCountries: ["CZ"],
      labels: ["person"],
      dictionaries: await getDictionaries(),
    });
    expect(
      entities.some(
        (entity) => entity.label === "person" && entity.text === "Jan Novak",
      ),
    ).toBe(true);
  });

  test("custom deny-list entries are matched without published dictionaries", async () => {
    const entities = await detect("Project Nebula appears in the agreement.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "Project Nebula",
          label: "organization",
          variants: ["Nebula Programme"],
        },
      ],
      labels: ["organization"],
    });
    expect(entities).toEqual([
      expect.objectContaining({
        label: "organization",
        text: "Project Nebula",
        source: "deny-list",
      }),
    ]);
  });

  test("custom deny-list entries preserve caller-owned exact terms", async () => {
    const entities = await detect(
      "Use api-key for ACME, DOMAIN\\user, foo|bar, 2024, 3.2.1, Buyer, .env, @acme, C++, and :ACME;.",
      {
        enableDenyList: true,
        customDenyList: [
          {
            value: "api-key",
            label: "secret",
          },
          {
            value: "ACME",
            label: "organization",
          },
          {
            value: "DOMAIN\\user",
            label: "account",
          },
          {
            value: "foo|bar",
            label: "token",
          },
          {
            value: "2024",
            label: "project",
          },
          {
            value: "3.2.1",
            label: "matter",
          },
          {
            value: "Buyer",
            label: "organization",
          },
          {
            value: ".env",
            label: "file",
          },
          {
            value: "@acme",
            label: "handle",
          },
          {
            value: "C++",
            label: "language",
          },
          {
            value: ":ACME;",
            label: "token",
          },
        ],
        labels: [
          "account",
          "file",
          "handle",
          "language",
          "matter",
          "secret",
          "organization",
          "project",
          "token",
        ],
      },
    );

    expect(entities).toEqual([
      expect.objectContaining({
        label: "secret",
        text: "api-key",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "organization",
        text: "ACME",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "account",
        text: "DOMAIN\\user",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "token",
        text: "foo|bar",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "project",
        text: "2024",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "matter",
        text: "3.2.1",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "organization",
        text: "Buyer",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "file",
        text: ".env",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "handle",
        text: "@acme",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "language",
        text: "C++",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "token",
        text: ":ACME;",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("plain custom deny-list entries keep token boundaries", async () => {
    const entities = await detect(
      "annual review for Joanne, ABC++, C++foo, A, Ann, and C++.",
      {
        enableDenyList: true,
        customDenyList: [
          {
            value: "Ann",
            label: "person",
          },
          {
            value: "A",
            label: "grade",
          },
          {
            value: "C++",
            label: "language",
          },
        ],
        labels: ["grade", "language", "person"],
      },
    );

    expect(entities).toEqual([
      expect.objectContaining({
        label: "grade",
        text: "A",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "person",
        text: "Ann",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "language",
        text: "C++",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom deny-list monetary amounts skip amount-word widening", async () => {
    const entities = await detect("Invoice 1 529,-Kč (slovy jeden tisíc).", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "1 529,-Kč",
          label: "monetary amount",
        },
      ],
      labels: ["monetary amount"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "monetary amount",
        text: "1 529,-Kč",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom deny-list labels do not relax curated boundaries", async () => {
    const entities = await detect("ABC++ and C++foo and C++ are listed.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "C++",
          label: "language",
        },
      ],
      labels: ["language", "technology"],
      dictionaries: {
        denyList: {
          "technology/test": ["C++"],
        },
        denyListMeta: {
          "technology/test": {
            label: "technology",
            category: "Organizations",
            country: null,
          },
        },
      },
    });

    expect(
      entities.some(
        (entity) =>
          entity.label === "language" &&
          entity.text === "C++" &&
          entity.sourceDetail === "custom-deny-list",
      ),
    ).toBe(true);
    expect(entities.some((entity) => entity.text !== "C++")).toBe(false);
  });

  test("custom deny-list labels do not suppress later curated matches", async () => {
    const entities = await detect("acme and Acme are both mentioned.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "Acme",
          label: "project",
        },
      ],
      labels: [],
      dictionaries: {
        denyList: {
          "organizations/test": ["Acme"],
        },
        denyListMeta: {
          "organizations/test": {
            label: "organization",
            category: "Organizations",
            country: null,
          },
        },
      },
    });

    expect(
      entities.some(
        (entity) => entity.label === "project" && entity.text === "acme",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "organization" && entity.text === "Acme",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) => entity.label === "organization" && entity.text === "acme",
      ),
    ).toBe(false);
  });

  test("custom deny-list labels do not promote merged corpus labels", async () => {
    const entities = await detect("Jan was used as the project codename.", {
      enableDenyList: true,
      enableNameCorpus: true,
      customDenyList: [
        {
          value: "Jan",
          label: "project",
        },
      ],
      labels: [],
      dictionaries: {
        firstNames: {
          en: ["Jan"],
        },
      },
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "project",
        text: "Jan",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom deny-list organizations do not seed propagation", async () => {
    const entities = await detect("Acme s.r.o. signed. Acme later paid.", {
      enableDenyList: true,
      enableCoreference: true,
      customDenyList: [
        {
          value: "Acme s.r.o.",
          label: "organization",
        },
      ],
      labels: ["organization"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "organization",
        text: "Acme s.r.o.",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom deny-list organizations do not seed coreference", async () => {
    const entities = await detect(
      'Acme Incorporated (hereinafter "Acme") later paid Acme.',
      {
        enableDenyList: true,
        enableCoreference: true,
        customDenyList: [
          {
            value: "Acme Incorporated",
            label: "organization",
          },
        ],
        labels: ["organization"],
      },
    );

    expect(entities).toEqual([
      expect.objectContaining({
        label: "organization",
        text: "Acme Incorporated",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom address deny-list entries preserve exact spans", async () => {
    const entities = await detect("Office moved to 140 00 Praha 1 yesterday.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "Praha",
          label: "address",
        },
      ],
      labels: ["address"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "address",
        text: "Praha",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom address deny-list entries bypass role-prefix normalization", async () => {
    const entities = await detect("Adresa: nájemce Praha.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "nájemce Praha",
          label: "address",
        },
      ],
      labels: ["address"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "address",
        text: "nájemce Praha",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom address deny-list entries do not anchor street-context expansion", async () => {
    const entities = await detect(`${"x".repeat(200)} Ostrovní 225/1, Praha`, {
      enableDenyList: true,
      customDenyList: [
        {
          value: "Praha",
          label: "address",
        },
      ],
      labels: ["address"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "address",
        text: "Praha",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("adjacent custom deny-list entries preserve exact spans", async () => {
    const entities = await detect("Reference ABC-DEF is listed.", {
      enableDenyList: true,
      customDenyList: [
        {
          value: "ABC",
          label: "code",
        },
        {
          value: "DEF",
          label: "code",
        },
      ],
      labels: ["code"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "code",
        text: "ABC",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "code",
        text: "DEF",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);
  });

  test("custom regexes add caller-owned deterministic detectors", async () => {
    const entities = await detect("Internal matter STLL-4821 is referenced.", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "\\bSTLL-[0-9]{4}\\b",
          label: "matter reference",
          score: 1,
        },
      ],
      labels: ["matter reference"],
    });
    expect(entities).toEqual([
      expect.objectContaining({
        label: "matter reference",
        text: "STLL-4821",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("custom regexes preserve caller-owned spans during merge", async () => {
    const entities = await detect("Version 2024-01-02 is referenced.", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "\\d{4}",
          label: "code",
          score: 1,
        },
      ],
      labels: [],
    });

    expect(
      entities.some(
        (entity) =>
          entity.label === "code" &&
          entity.text === "2024" &&
          entity.sourceDetail === "custom-regex",
      ),
    ).toBe(true);
  });

  test("custom regexes preserve caller-owned match boundaries", async () => {
    const entities = await detect("Token XABCY is referenced.", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "ABC",
          label: "code",
          score: 1,
        },
      ],
      labels: ["code"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "code",
        text: "ABC",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("custom regexes skip boundary and amount widening", async () => {
    const entities = await detect(
      "Invoice 1 529,-Kč (slovy jeden tisíc) and ABC 2024-01-02.",
      {
        enableRegex: true,
        customRegexes: [
          {
            pattern: "1 529,-Kč",
            label: "monetary amount",
            score: 1,
          },
          {
            pattern: " ABC,?",
            label: "date",
            score: 1,
          },
        ],
        labels: ["date", "monetary amount"],
      },
    );

    expect(
      entities.some(
        (entity) =>
          entity.label === "monetary amount" &&
          entity.text === "1 529,-Kč" &&
          entity.sourceDetail === "custom-regex",
      ),
    ).toBe(true);
    expect(
      entities.some(
        (entity) =>
          entity.label === "date" &&
          entity.text === " ABC" &&
          entity.sourceDetail === "custom-regex",
      ),
    ).toBe(true);
    expect(entities.some((entity) => entity.text === "ABC 2024-01-02")).toBe(
      false,
    );
  });

  test("custom regexes skip hotword relabeling", async () => {
    const entities = await detect("narozen dne 12.03.1990", {
      enableRegex: true,
      enableHotwordRules: true,
      customRegexes: [
        {
          pattern: "12\\.03\\.1990",
          label: "date",
          score: 1,
        },
      ],
      labels: ["date"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "date",
        text: "12.03.1990",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("unrequested custom regexes do not constrain address context", async () => {
    const entities = await detect("Olbrachtova 1929/62, 140 00 Praha 4", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "Praha",
          label: "person",
          score: 1,
        },
      ],
      labels: ["address"],
    });

    const address = entities.find((entity) => entity.label === "address");
    expect(address).toBeDefined();
    expect(address!.text).toContain("Olbrachtova 1929/62");
    expect(address!.text).toContain("140 00 Praha 4");
  });

  test("custom regex organizations do not seed coreference", async () => {
    const entities = await detect(
      'Acme Incorporated (hereinafter "Acme") later paid Acme.',
      {
        enableRegex: true,
        enableCoreference: true,
        customRegexes: [
          {
            pattern: "Acme Incorporated",
            label: "organization",
            score: 1,
          },
        ],
        labels: ["organization"],
      },
    );

    expect(entities).toEqual([
      expect.objectContaining({
        label: "organization",
        text: "Acme Incorporated",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("custom regex phone numbers bypass built-in length gates", async () => {
    const entities = await detect("Internal extension 1234 is listed.", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "\\b\\d{4}\\b",
          label: "phone number",
          score: 1,
        },
      ],
      labels: ["phone number"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "phone number",
        text: "1234",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("custom regexes preserve caller-owned false-positive-looking matches", async () => {
    const entities = await detect("Matter AB is referenced.", {
      enableRegex: true,
      customRegexes: [
        {
          pattern: "\\bAB\\b",
          label: "registration number",
          score: 1,
        },
      ],
      labels: ["registration number"],
    });
    expect(entities).toEqual([
      expect.objectContaining({
        label: "registration number",
        text: "AB",
        source: "regex",
        sourceDetail: "custom-regex",
      }),
    ]);
  });

  test("label-filtered custom regexes do not mask requested NER labels", async () => {
    const fullText = "John met Alice.";
    const entities = await runPipeline({
      fullText,
      config: {
        ...BASE_CONFIG,
        enableRegex: true,
        enableNer: true,
        customRegexes: [
          {
            pattern: "John",
            label: "code",
          },
        ],
        labels: ["person"],
      },
      gazetteerEntries: [],
      context: createPipelineContext(),
      nerInference: async (maskedText) => {
        expect(maskedText).toBe(fullText);
        return [
          {
            start: 0,
            end: 4,
            label: "person",
            text: "John",
            score: 0.95,
            source: "ner",
          },
        ];
      },
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "person",
        text: "John",
        source: "ner",
      }),
    ]);
  });

  test("hotword reclassification can promote filtered source labels into requested output labels", async () => {
    const entities = await detect("narozen dne 12.03.1990 v Praze", {
      enableRegex: true,
      enableHotwordRules: true,
      labels: ["date of birth"],
    });
    expect(
      entities.some(
        (entity) =>
          entity.label === "date of birth" && entity.text === "12.03.1990",
      ),
    ).toBe(true);
  });

  test("address seed expansion keeps unfiltered NER boundaries in context", async () => {
    const fullText = "Jan Novák, Olbrachtova 1929/62, 140 00 Praha 4";
    const personEnd = fullText.indexOf(",");
    const entities = await runPipeline({
      fullText,
      config: {
        ...BASE_CONFIG,
        enableNer: true,
        labels: ["address"],
      },
      gazetteerEntries: [],
      context: createPipelineContext(),
      nerInference: async () => [
        {
          start: 0,
          end: personEnd,
          label: "person",
          text: fullText.slice(0, personEnd),
          score: 0.95,
          source: "ner",
        },
      ],
    });
    const address = entities.find((entity) => entity.label === "address");
    expect(address).toBeDefined();
    expect(address!.text).toContain("Olbrachtova 1929/62");
    expect(address!.text).toContain("140 00 Praha 4");
    expect(address!.text).not.toContain("Jan Novák");
  });

  test("address-only output still respects non-address bounds during seed expansion", async () => {
    const entities = await detect(
      "Acme s.r.o., Dělnická 213/12, 170 00 Praha 7",
      {
        enableLegalForms: true,
        labels: ["address"],
      },
    );
    const address = entities.find((entity) => entity.label === "address");
    expect(address).toBeDefined();
    expect(address!.text).toContain("Dělnická 213/12");
    expect(address!.text).toContain("Praha 7");
    expect(address!.text).not.toContain("Acme");
  });
});

describe("misc entity label", () => {
  test("crypto is exported in DEFAULT_ENTITY_LABELS", () => {
    expect(DEFAULT_ENTITY_LABELS).toContain("crypto");
  });

  test("misc is exported in DEFAULT_ENTITY_LABELS", () => {
    expect(DEFAULT_ENTITY_LABELS).toContain("misc");
  });

  test("no detector fires misc on plain text", async () => {
    const entities = await detect(
      "Jan Novák lives in Praha and works at Acme s.r.o.",
      {
        enableRegex: true,
        enableLegalForms: true,
        enableTriggerPhrases: true,
        enableDenyList: true,
        enableNameCorpus: true,
        enableGazetteer: true,
        denyListCountries: ["CZ"],
        labels: [...DEFAULT_ENTITY_LABELS],
        dictionaries: await getDictionaries(),
      },
    );
    expect(entities.some((entity) => entity.label === "misc")).toBe(false);
  });

  test("custom deny-list with misc label yields [MISC_N] placeholder", async () => {
    const fullText = "The case file references Widget X and Widget X again.";
    const entities = await detect(fullText, {
      enableDenyList: true,
      customDenyList: [
        {
          value: "Widget X",
          label: "misc",
        },
      ],
      labels: ["misc"],
    });

    expect(entities).toEqual([
      expect.objectContaining({
        label: "misc",
        text: "Widget X",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
      expect.objectContaining({
        label: "misc",
        text: "Widget X",
        source: "deny-list",
        sourceDetail: "custom-deny-list",
      }),
    ]);

    const { redactedText, redactionMap } = redactText(fullText, entities);
    expect(redactedText).toBe(
      "The case file references [MISC_1] and [MISC_1] again.",
    );
    expect(redactionMap.get("[MISC_1]")).toBe("Widget X");
  });

  test("misc case-variants share a placeholder", async () => {
    // `Widget X` and `widget x` are the same real-world entity from
    // the user's perspective; redact.ts case-normalises MISC so both
    // surface forms collapse to one placeholder, matching
    // PERSON/ORG/ADDRESS behaviour.
    const fullText = "Widget X starts a sentence; later widget x reappears.";
    const entities = await detect(fullText, {
      enableDenyList: true,
      customDenyList: [{ value: "Widget X", label: "misc" }],
      labels: ["misc"],
    });
    const { redactedText, redactionMap } = redactText(fullText, entities);
    expect(redactedText).toBe(
      "[MISC_1] starts a sentence; later [MISC_1] reappears.",
    );
    expect(redactionMap.size).toBe(1);
  });

  test("NER inference is skipped when only non-NER labels are requested", async () => {
    // Filtering deterministic/custom-only labels out of the
    // NER schema can leave the schema empty (e.g.
    // caller passes `labels: ["crypto", "misc"]`).
    // Many NER backends reject empty label arrays; the
    // pipeline should skip the call entirely in that case.
    let nerCalled = false;
    await runPipeline({
      fullText: "Project Widget X is mentioned.",
      config: {
        threshold: 0.5,
        enableTriggerPhrases: false,
        enableRegex: false,
        enableLegalForms: false,
        enableNameCorpus: false,
        enableDenyList: true,
        enableGazetteer: false,
        enableNer: true,
        enableConfidenceBoost: false,
        enableCoreference: false,
        customDenyList: [{ value: "Widget X", label: "misc" }],
        labels: ["crypto", "misc"],
        workspaceId: "test",
      },
      gazetteerEntries: [],
      context: createPipelineContext(),
      nerInference: async () => {
        nerCalled = true;
        return [];
      },
    });
    expect(nerCalled).toBe(false);
  });

  test("non-NER labels are excluded from the NER label schema", async () => {
    // These labels are deterministic/custom-only; surfacing them
    // to the NER schema would invite zero-shot guesses on
    // arbitrary spans.
    const seenLabels: string[][] = [];
    await runPipeline({
      fullText: "Some sentence.",
      config: {
        threshold: 0.5,
        enableTriggerPhrases: false,
        enableRegex: false,
        enableLegalForms: false,
        enableNameCorpus: false,
        enableDenyList: false,
        enableGazetteer: false,
        enableNer: true,
        enableConfidenceBoost: false,
        enableCoreference: false,
        labels: [...DEFAULT_ENTITY_LABELS],
        workspaceId: "test",
      },
      gazetteerEntries: [],
      context: createPipelineContext(),
      nerInference: async (_text, labels) => {
        seenLabels.push([...labels]);
        return [];
      },
    });
    expect(seenLabels.length).toBe(1);
    expect(seenLabels[0]).not.toContain("crypto");
    expect(seenLabels[0]).not.toContain("misc");
    // Sanity: other defaults still flow through unchanged.
    expect(seenLabels[0]).toContain("person");
  });
});
