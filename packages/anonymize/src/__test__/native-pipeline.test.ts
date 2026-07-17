/**
 * Native-pipeline surface tests.
 *
 * These preserve the behaviors that used to live in the (deleted)
 * `pipeline-config.test.ts` but that are NOT about the retired TypeScript
 * config assembly (whose correctness is now owned by the Rust parity fixtures
 * in `crates/anonymize-core/tests/fixtures/assemble`):
 *
 * - `prepareNativePipelineConfig` returns a config assembled by the Rust
 *   binding (shape / trivial-field pass-through).
 * - `prepareNativePipelinePackage` caches per context and dedupes.
 * - `createNativePipelineFromConfig` yields a working redactor.
 * - Language scope is applied end-to-end through the new Rust path.
 */
import { describe, expect, test } from "bun:test";

import { createPipelineContext } from "../context";
import { applyPipelineLanguageScope } from "../language-scope";
import type { NativeAnonymizeBinding } from "../native";
import { loadNativeAnonymizeBinding } from "../native-node";
import {
  createNativePipelineFromConfig,
  prepareNativePipelineConfig,
  prepareNativePipelinePackage,
  SHARED_PACKAGE_CACHE_MAX_ENTRIES,
} from "../native-pipeline";
import { DEFAULT_ENTITY_LABELS, type PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";

const binding = loadNativeAnonymizeBinding();

const baseConfig = (): PipelineConfig => ({
  threshold: 0.5,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableLegalForms: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableCountries: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "native-pipeline-test",
});

describe("prepareNativePipelineConfig", () => {
  test("assembles a config via the Rust binding and passes trivial fields through", async () => {
    const prepared = await prepareNativePipelineConfig({
      binding,
      config: { ...baseConfig(), enableRegex: true, threshold: 0.42 },
    });

    expect(Array.isArray(prepared.regex_patterns)).toBe(true);
    expect(Array.isArray(prepared.custom_regex_patterns)).toBe(true);
    expect(Array.isArray(prepared.literal_patterns)).toBe(true);
    expect(prepared.slices.regex).toBeDefined();
    expect(prepared.threshold).toBe(0.42);
    expect(prepared.allowed_labels).toEqual([...DEFAULT_ENTITY_LABELS]);
    // Enabling regex must produce at least one baked regex pattern.
    expect(prepared.regex_patterns.length).toBeGreaterThan(0);
  });

  test("normalizes an omitted deprecated NER flag to false", async () => {
    const config = baseConfig();
    delete config.enableNer;

    const prepared = await prepareNativePipelineConfig({ binding, config });

    expect(prepared.allowed_labels).toEqual([...DEFAULT_ENTITY_LABELS]);
  });
});

describe("prepareNativePipelinePackage", () => {
  test("returns byte-identical bytes and caches on the context", async () => {
    const config: PipelineConfig = { ...baseConfig(), enableRegex: true };
    const ctx = createPipelineContext();

    const first = await prepareNativePipelinePackage({
      binding,
      config,
      context: ctx,
    });
    expect(ctx.nativePipelinePackage).not.toBeNull();

    const second = await prepareNativePipelinePackage({
      binding,
      config,
      context: ctx,
    });

    // Each call returns a defensive copy, so identities differ but the bytes
    // must be identical (served from the shared cache).
    expect(second).not.toBe(first);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  test("compressed and raw packages differ", async () => {
    const config: PipelineConfig = { ...baseConfig(), enableRegex: true };
    const raw = await prepareNativePipelinePackage({
      binding,
      config,
      context: createPipelineContext(),
    });
    const compressed = await prepareNativePipelinePackage({
      binding,
      config,
      context: createPipelineContext(),
      compressed: true,
    });
    expect(Buffer.from(compressed).equals(Buffer.from(raw))).toBe(false);
  });
});

describe("createNativePipelineFromConfig", () => {
  test("builds a redactor that detects a custom-regex entity", async () => {
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: {
        ...baseConfig(),
        enableRegex: true,
        labels: ["custom"],
        customRegexes: [{ pattern: "SECRET-\\d+", label: "custom" }],
      },
    });

    const { redaction } = pipeline.redactText("code SECRET-42 end");
    expect(redaction.entityCount).toBeGreaterThan(0);
    expect(redaction.redactedText).not.toContain("SECRET-42");
  });

  test("round-trips encrypted session archives through the native binding", async () => {
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: {
        ...baseConfig(),
        enableRegex: true,
        labels: ["custom"],
        customRegexes: [{ pattern: "SECRET-\\d+", label: "custom" }],
      },
    });
    const key = new Uint8Array(32).fill(0x42);
    const session = pipeline.createRedactionSession("archive_case_1");
    const initial = session.redactText("code SECRET-42 end");
    const placeholders = [...initial.redaction.redactionMap.keys()];
    expect(placeholders).toHaveLength(1);
    const placeholder = placeholders.at(0);
    if (placeholder === undefined) {
      throw new Error("Expected the session redaction to create a placeholder");
    }
    expect(session.restoreText(`repeat ${placeholder}`)).toBe(
      "repeat SECRET-42",
    );
    expect(session.restore_text(placeholder)).toBe("SECRET-42");
    const firstArchive = session.toEncryptedArchive(key);
    const secondArchive = session.to_encrypted_archive(key);

    expect(firstArchive).toBeInstanceOf(Uint8Array);
    expect(firstArchive).not.toEqual(secondArchive);
    expect(new TextDecoder().decode(firstArchive)).not.toContain("SECRET-42");

    const restored = pipeline.restoreEncryptedRedactionSession({
      archive: firstArchive,
      key,
      expectedSessionId: "archive_case_1",
    });
    const continued = restored.redactText("again SECRET-42");
    expect(continued.redaction.redactedText).toContain(placeholder);

    expect(() =>
      pipeline.restoreEncryptedRedactionSession({
        archive: firstArchive,
        key: new Uint8Array(32).fill(0x24),
        expectedSessionId: "archive_case_1",
      }),
    ).toThrow("Encrypted session archive authentication failed");
    expect(() =>
      pipeline.restoreEncryptedRedactionSession({
        archive: firstArchive,
        key,
        expectedSessionId: "archive_case_2",
      }),
    ).toThrow("Encrypted session archive authentication failed");
    expect(() => session.toEncryptedArchive(new Uint8Array(31))).toThrow(
      "must be exactly 32 bytes",
    );

    const lifecycle = pipeline.createRedactionSessionWithLifecycle({
      sessionId: "archive_lifecycle_1",
      createdAtEpochSeconds: 100,
      expiresAtEpochSeconds: 200,
    });
    const lifecycleArchive = lifecycle.toEncryptedArchiveAt(key, 150);
    const lifecycleRedaction = lifecycle.redactTextAt({
      fullText: "code SECRET-42 end",
      observedAtEpochSeconds: 150,
    });
    const lifecyclePlaceholder = [
      ...lifecycleRedaction.redaction.redactionMap.keys(),
    ].at(0);
    if (lifecyclePlaceholder === undefined) {
      throw new Error("Expected lifecycle session placeholder");
    }
    expect(lifecycle.restoreText(lifecyclePlaceholder, 150)).toBe("SECRET-42");
    expect(() => lifecycle.restoreText(lifecyclePlaceholder)).toThrow(
      "caller-supplied observation time",
    );
    expect(() => lifecycle.restoreText(lifecyclePlaceholder, 200)).toThrow(
      "expired",
    );
    expect(
      pipeline
        .restore_encrypted_redaction_session({
          archive: lifecycleArchive,
          key,
          expectedSessionId: "archive_lifecycle_1",
          observedAtEpochSeconds: 150,
        })
        .inspect(150).status,
    ).toBe("active");
    expect(() =>
      pipeline.restoreEncryptedRedactionSession({
        archive: lifecycleArchive,
        key,
        expectedSessionId: "archive_lifecycle_1",
        observedAtEpochSeconds: 200,
      }),
    ).toThrow("expired");
  });

  test("redacts caller detections using JavaScript UTF-16 offsets", async () => {
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: { ...baseConfig(), labels: ["person"] },
    });

    const result = pipeline.redactTextWithCallerDetections("😀Alice signed.", {
      detections: [
        {
          start: 2,
          end: 7,
          label: "person",
          score: 0.9,
          providerId: "test-provider",
          detectionId: "person-1",
        },
      ],
    });

    expect(result.redaction.redactedText).toBe("😀[PERSON_1] signed.");
    expect(result.resolvedEntities).toEqual([
      expect.objectContaining({
        start: 2,
        end: 7,
        text: "Alice",
        source: "caller",
        providerId: "test-provider",
        detectionId: "person-1",
      }),
    ]);

    const diagnosticsJson =
      pipeline.redactTextWithCallerDetectionsDiagnosticsJson(
        "😀Alice signed.",
        {
          detections: [
            {
              start: 2,
              end: 7,
              label: "person",
              score: 0.9,
              providerId: "test-provider",
              detectionId: "person-1",
            },
          ],
        },
      );
    expect(diagnosticsJson).not.toBeNull();
    expect(diagnosticsJson).toContain('"provider_id":"test-provider"');
    expect(diagnosticsJson).toContain('"detection_id":"person-1"');
    const diagnosticsResult: {
      diagnostics: { events: Array<{ text?: string }> };
    } = JSON.parse(diagnosticsJson ?? "{}");
    expect(
      diagnosticsResult.diagnostics.events.every(
        ({ text }) => text === undefined,
      ),
    ).toBeTrue();

    const kept = pipeline.redactTextWithCallerDetections("😀Alice signed.", {
      detections: [
        {
          start: 2,
          end: 7,
          label: "person",
          score: 0.9,
          providerId: "test-provider",
          detectionId: "person-1",
        },
      ],
      operators: { operators: { person: "keep" } },
    });
    expect(kept.redaction.redactedText).toBe("😀Alice signed.");
    expect(kept.redaction.entityCount).toBe(1);
    expect(kept.redaction.redactionMap.size).toBe(0);
    expect(kept.redaction.operatorMap.get("[PERSON_1]")).toBe("keep");

    const masked = pipeline.redactTextWithCallerDetections(
      "A👨‍👩‍👧‍👦e\u{301}Z signed.",
      {
        detections: [
          {
            start: 0,
            end: 15,
            label: "person",
            score: 0.9,
            providerId: "test-provider",
            detectionId: "person-mask-1",
          },
        ],
        operators: {
          operators: {
            person: {
              type: "mask",
              maskingCharacter: "●",
              charactersToMask: 2,
              direction: "end",
            },
          },
        },
      },
    );
    expect(masked.redaction.redactedText).toBe("A👨‍👩‍👧‍👦●● signed.");
    expect(masked.redaction.redactionMap.size).toBe(0);
    expect(masked.redaction.operatorMap.get("[PERSON_1]")).toBe("mask");
  });

  test("plans caller-detection session updates transactionally", async () => {
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: { ...baseConfig(), labels: ["person"] },
    });
    const session = pipeline.createRedactionSession("workflow_case_1");
    const plan = session.planTextBatchWithCallerDetections({
      inputs: [
        {
          fullText: "😀Alice signed.",
          detections: [
            {
              start: 2,
              end: 7,
              label: "person",
              score: 0.9,
              providerId: "test-provider",
              detectionId: "person-1",
            },
          ],
        },
        {
          fullText: "Alice replied.",
          detections: [
            {
              start: 0,
              end: 5,
              label: "person",
              score: 0.9,
              providerId: "test-provider",
              detectionId: "person-2",
            },
          ],
        },
      ],
    });

    expect(session.mappingCount()).toBe(0);
    expect(plan.blocks).toEqual([
      {
        replacements: [
          {
            start: 2,
            end: 7,
            replacement: "[PERSON_workflow%5Fcase%5F1_1]",
          },
        ],
        entityCount: 1,
        callerEntityCount: 1,
      },
      {
        replacements: [
          {
            start: 0,
            end: 5,
            replacement: "[PERSON_workflow%5Fcase%5F1_1]",
          },
        ],
        entityCount: 1,
        callerEntityCount: 1,
      },
    ]);
    plan.commit();
    expect(session.mappingCount()).toBe(1);
    expect(session.restoreText("[PERSON_workflow%5Fcase%5F1_1]")).toBe("Alice");
    expect(() => plan.commit()).toThrow("already been committed");

    const bobPlan = session.planTextBatchWithCallerDetections({
      inputs: [
        {
          fullText: "Bob",
          detections: [
            {
              start: 0,
              end: 3,
              label: "person",
              score: 0.9,
              providerId: "test-provider",
              detectionId: "person-3",
            },
          ],
        },
      ],
    });
    const carolPlan = session.planTextBatchWithCallerDetections({
      inputs: [
        {
          fullText: "Carol",
          detections: [
            {
              start: 0,
              end: 5,
              label: "person",
              score: 0.9,
              providerId: "test-provider",
              detectionId: "person-4",
            },
          ],
        },
      ],
    });
    bobPlan.commit();
    expect(() => carolPlan.commit()).toThrow(
      "changed after the plan was created",
    );
  });
});

describe("language scope", () => {
  test("passing a content language is equivalent to the explicitly scoped name-corpus languages", async () => {
    const dictionaries = await loadTestDictionaries();
    const config: PipelineConfig = {
      ...baseConfig(),
      dictionaries,
      enableNameCorpus: true,
      labels: ["person"],
    };

    const viaLanguage = await prepareNativePipelineConfig({
      binding,
      config: { ...config, language: "cs" },
    });
    const scoped = applyPipelineLanguageScope({ ...config, language: "cs" });
    const viaExplicit = await prepareNativePipelineConfig({
      binding,
      config: {
        ...config,
        ...(scoped.nameCorpusLanguages
          ? { nameCorpusLanguages: scoped.nameCorpusLanguages }
          : {}),
      },
    });

    expect(viaLanguage.name_corpus_data).toBeDefined();
    expect(viaLanguage.name_corpus_data).toEqual(viaExplicit.name_corpus_data);

    // A different content language selects a different name corpus, proving the
    // scope actually flows through the Rust assembler.
    const viaGerman = await prepareNativePipelineConfig({
      binding,
      config: { ...config, language: "de" },
    });
    expect(viaGerman.name_corpus_data).not.toEqual(
      viaLanguage.name_corpus_data,
    );
  });
});

describe("shared prepared-package cache bound", () => {
  // Security regression: `nativePackageCacheKey` fingerprints caller-supplied
  // config (custom regexes, deny lists, gazetteer entries), so a caller that
  // sweeps through many distinct values used to grow the shared package cache
  // (and the multi-MB assembled packages it holds) without limit. The cache
  // must now evict least-recently-used entries once it hits
  // `SHARED_PACKAGE_CACHE_MAX_ENTRIES`.
  test("evicts least-recently-used entries once the dictionary-less bucket is at capacity", async () => {
    let buildCount = 0;
    const countingBinding: NativeAnonymizeBinding = {
      ...binding,
      assembleStaticSearchPackageBytes: (...args) => {
        buildCount += 1;
        const assemble = binding.assembleStaticSearchPackageBytes;
        if (assemble === undefined) {
          throw new Error(
            "binding does not support assembleStaticSearchPackageBytes",
          );
        }
        return assemble(...args);
      },
    };

    // A unique custom-regex pattern per iteration gives each config a
    // distinct `pipelineConfigKey`, so each call is a genuinely new cache
    // entry rather than a dedupe hit.
    const configFor = (n: number): PipelineConfig => ({
      ...baseConfig(),
      enableRegex: true,
      labels: ["custom"],
      customRegexes: [
        { pattern: `SHARED-CACHE-BOUND-TEST-${n}-\\d+`, label: "custom" },
      ],
    });

    // Fill the shared cache past capacity with distinct configs, each on its
    // own context so only the module-level shared cache (not the
    // per-context cache) is exercised.
    const total = SHARED_PACKAGE_CACHE_MAX_ENTRIES + 4;
    for (let n = 0; n < total; n += 1) {
      await prepareNativePipelinePackage({
        binding: countingBinding,
        config: configFor(n),
        context: createPipelineContext(),
      });
    }
    const buildsAfterFill = buildCount;

    // The earliest config was evicted long ago: rebuilding it must miss the
    // cache and trigger a fresh assemble call, proving the cache did not
    // grow without bound.
    await prepareNativePipelinePackage({
      binding: countingBinding,
      config: configFor(0),
      context: createPipelineContext(),
    });
    expect(buildCount).toBe(buildsAfterFill + 1);

    // The most recently inserted config is still within the cap and must
    // still be served from the cache without a rebuild.
    await prepareNativePipelinePackage({
      binding: countingBinding,
      config: configFor(total - 1),
      context: createPipelineContext(),
    });
    expect(buildCount).toBe(buildsAfterFill + 1);
  });
});
