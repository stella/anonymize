import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(join(import.meta.dir, "..", "..", ".."));
const PACKAGE_DIR = join(ROOT_DIR, "packages", "anonymize");
const FIXTURES_DIR = join(
  PACKAGE_DIR,
  "src",
  "__test__",
  "fixtures",
  "contracts",
);
const BASELINE_REF =
  process.env.ANONYMIZE_MIGRATION_BASELINE_REF ?? "origin/main";
const WORKING_TREE_BASELINE_REF = "working-tree";
const COMPARE_BASELINE =
  process.env.ANONYMIZE_MIGRATION_COMPARE_BASELINE !== "0";
const REQUIRE_NATIVE_PIPELINE =
  process.env.ANONYMIZE_MIGRATION_REQUIRE_NATIVE_PIPELINE === "1";
const CANDIDATE_RUNTIME =
  process.env.ANONYMIZE_MIGRATION_CANDIDATE_RUNTIME ?? "typescript";
const FAIL_ON_MISMATCH =
  process.env.ANONYMIZE_MIGRATION_FAIL_ON_MISMATCH ??
  (CANDIDATE_RUNTIME === "typescript" ? "1" : "0");
const WARM_ITERATIONS = positiveIntegerEnv(
  "ANONYMIZE_MIGRATION_WARM_ITERATIONS",
  2,
);
const CACHED_PREPARE_ITERATIONS = positiveIntegerEnv(
  "ANONYMIZE_MIGRATION_CACHED_PREPARE_ITERATIONS",
  3,
);
const PROFILE_REGEX_LABELS =
  process.env.ANONYMIZE_MIGRATION_PROFILE_REGEX_LABELS === "1";
const PROFILE_SCOPED_PREPARE =
  process.env.ANONYMIZE_MIGRATION_PROFILE_SCOPED_PREPARE === "1";
const NATIVE_PREPARED_PACKAGE =
  process.env.ANONYMIZE_MIGRATION_NATIVE_PREPARED_PACKAGE === "1";
const NATIVE_COMPRESSED_PACKAGE =
  process.env.ANONYMIZE_MIGRATION_NATIVE_COMPRESSED_PACKAGE === "1";
const NATIVE_PREPARED_ARTIFACTS =
  !NATIVE_PREPARED_PACKAGE &&
  process.env.ANONYMIZE_MIGRATION_NATIVE_PREPARED_ARTIFACTS === "1";
const FIXTURE_LANGUAGE_FILTER = stringListEnv(
  "ANONYMIZE_MIGRATION_FIXTURE_LANGUAGES",
);
const CONTENT_LANGUAGE =
  process.env.ANONYMIZE_MIGRATION_CONTENT_LANGUAGE?.trim() ?? "";
const NATIVE_CONFIG_PATH =
  process.env.ANONYMIZE_MIGRATION_NATIVE_CONFIG_PATH?.trim() ?? "";
const WRITE_NATIVE_CONFIG_PATH =
  process.env.ANONYMIZE_MIGRATION_WRITE_NATIVE_CONFIG_PATH?.trim() ?? "";
const NATIVE_PACKAGE_PATH =
  process.env.ANONYMIZE_MIGRATION_NATIVE_PACKAGE_PATH?.trim() ?? "";
const WRITE_NATIVE_PACKAGE_PATH =
  process.env.ANONYMIZE_MIGRATION_WRITE_NATIVE_PACKAGE_PATH?.trim() ?? "";
const USER_DATA_SCENARIO =
  process.env.ANONYMIZE_MIGRATION_USER_DATA_SCENARIO?.trim() ?? "none";

const ACCEPTED_NATIVE_STATIC_DELTAS = new Map(
  [
    {
      fixture: "cs/asset-transfer-court-declensions.txt",
      reason: "wider-address-span",
      candidateExtra: [
        { start: 445, end: 485, label: "address", source: "regex" },
      ],
      candidateMissing: [
        { start: 471, end: 485, label: "address", source: "deny-list" },
      ],
    },
    {
      fixture: "cs/nakit-legal-services-framework.txt",
      reason: "role-heading-not-person",
      candidateExtra: [],
      candidateMissing: [
        { start: 49384, end: 49395, label: "person", source: "trigger" },
      ],
    },
    {
      fixture: "cs/vinci-donation-agreement.txt",
      reason: "party-organization-retained",
      candidateExtra: [
        { start: 542, end: 585, label: "organization", source: "deny-list" },
      ],
      candidateMissing: [],
    },
    {
      fixture: "en/software-license-agreement.txt",
      reason: "phone-leading-parenthesis",
      candidateExtra: [
        { start: 1857, end: 1871, label: "phone number", source: "regex" },
      ],
      candidateMissing: [
        { start: 1858, end: 1871, label: "phone number", source: "trigger" },
      ],
    },
  ].map((entry) => [entry.fixture, entry]),
);

if (process.env.ANONYMIZE_MIGRATION_WORKER === "1") {
  await runWorker();
} else {
  await runCoordinator();
}

async function runCoordinator() {
  const fixtures = discoverFixtures(FIXTURES_DIR).filter((fixture) =>
    FIXTURE_LANGUAGE_FILTER.length === 0
      ? true
      : FIXTURE_LANGUAGE_FILTER.includes(fixtureLanguage(fixture)),
  );
  if (fixtures.length === 0) {
    throw new Error(`No contract fixtures found in ${FIXTURES_DIR}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "stella-anonymize-migration-"));

  try {
    let baseline = null;
    if (COMPARE_BASELINE) {
      const baselineRoot =
        BASELINE_REF === WORKING_TREE_BASELINE_REF
          ? ROOT_DIR
          : materializeBaselineRef(BASELINE_REF, tempRoot);
      baseline = runVariant({
        name: `baseline:${BASELINE_REF}`,
        sourceRoot: baselineRoot,
        fixtures,
        tempRoot,
      });
      printVariantSummary(baseline);
    }

    const candidate = runVariant({
      name: "candidate",
      sourceRoot: ROOT_DIR,
      fixtures,
      tempRoot,
      runtime: CANDIDATE_RUNTIME,
    });
    printVariantSummary(candidate);

    if (
      REQUIRE_NATIVE_PIPELINE &&
      !candidate.nativeRewrite.measuredInPipeline
    ) {
      throw new Error(
        "Native pipeline is required, but the candidate run used the TypeScript pipeline",
      );
    }

    if (baseline !== null) {
      const comparison = compareSnapshots(baseline, candidate);
      console.log(JSON.stringify(comparison));
      if (!comparison.equal && FAIL_ON_MISMATCH !== "0") {
        throw new Error(
          `Fixture parity failed for ${comparison.mismatches.length} fixture(s)`,
        );
      }
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function runVariant({
  name,
  sourceRoot,
  fixtures,
  tempRoot,
  runtime = "typescript",
}) {
  validateRuntime(runtime);
  if (runtime === "native-static") {
    ensureNativeAdapterBuilt();
  }

  const resultPath = join(
    tempRoot,
    `${name.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}.json`,
  );
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ANONYMIZE_MIGRATION_WORKER: "1",
      ANONYMIZE_MIGRATION_SOURCE_ROOT: sourceRoot,
      ANONYMIZE_MIGRATION_VARIANT: name,
      ANONYMIZE_MIGRATION_RUNTIME: runtime,
      ANONYMIZE_MIGRATION_FIXTURES_DIR: FIXTURES_DIR,
      ANONYMIZE_MIGRATION_FIXTURES: JSON.stringify(fixtures),
      ANONYMIZE_MIGRATION_RESULT_PATH: resultPath,
      ANONYMIZE_MIGRATION_WARM_ITERATIONS: String(WARM_ITERATIONS),
      ANONYMIZE_MIGRATION_CACHED_PREPARE_ITERATIONS: String(
        CACHED_PREPARE_ITERATIONS,
      ),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (child.status !== 0) {
    throw new Error(
      [
        `Migration fixture worker failed for ${name}`,
        child.stdout.trim(),
        child.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return JSON.parse(readFileSync(resultPath, "utf8"));
}

async function runWorker() {
  const sourceRoot = requiredEnv("ANONYMIZE_MIGRATION_SOURCE_ROOT");
  const variant = requiredEnv("ANONYMIZE_MIGRATION_VARIANT");
  const runtime = requiredEnv("ANONYMIZE_MIGRATION_RUNTIME");
  const resultPath = requiredEnv("ANONYMIZE_MIGRATION_RESULT_PATH");
  const fixtures = JSON.parse(requiredEnv("ANONYMIZE_MIGRATION_FIXTURES"));
  validateRuntime(runtime);
  const usePrebuiltNativePackage =
    runtime === "native-static" && NATIVE_PACKAGE_PATH.length > 0;
  const usePrebuiltNativeConfig =
    !usePrebuiltNativePackage &&
    runtime === "native-static" &&
    NATIVE_CONFIG_PATH.length > 0;

  let indexModule = null;
  let config = null;
  let context = null;
  let search = null;
  let nativeConfigBytes = null;
  let nativePackageBuffer = null;
  let importMs = 0;
  let dictionaryMs = 0;
  let prepareMs = 0;
  let nativeConfigReadMs = 0;
  let nativeConfigParseMs = 0;
  let nativePackageReadMs = 0;
  let nativePackageCompressed = NATIVE_COMPRESSED_PACKAGE;

  if (usePrebuiltNativePackage) {
    const packageReadStart = Bun.nanoseconds();
    nativePackageBuffer = readFileSync(NATIVE_PACKAGE_PATH);
    nativePackageReadMs = elapsedMs(packageReadStart);
    nativePackageCompressed = isCompressedNativePackage(nativePackageBuffer);
  } else if (usePrebuiltNativeConfig) {
    const configReadStart = Bun.nanoseconds();
    nativeConfigBytes = readFileSync(NATIVE_CONFIG_PATH);
    nativeConfigReadMs = elapsedMs(configReadStart);
    const configParseStart = Bun.nanoseconds();
    search = {
      nativeStaticConfig: JSON.parse(nativeConfigBytes.toString("utf8")),
    };
    nativeConfigParseMs = elapsedMs(configParseStart);
  } else {
    const importStart = Bun.nanoseconds();
    const [loadedIndexModule, configModule, dictionaryModule] =
      await Promise.all([
        importSource(sourceRoot, "packages/anonymize/src/index.ts", variant),
        importSource(
          sourceRoot,
          "packages/anonymize/src/__test__/contract-config.ts",
          variant,
        ),
        importSource(
          sourceRoot,
          "packages/anonymize/src/__test__/load-dictionaries.ts",
          variant,
        ),
      ]);
    indexModule = loadedIndexModule;
    importMs = elapsedMs(importStart);

    const scope = contentLanguageScope();
    const dictionaryStart = Bun.nanoseconds();
    const dictionaries = await dictionaryModule.loadTestDictionaries(scope);
    dictionaryMs = elapsedMs(dictionaryStart);

    config = {
      ...configModule.contractTestConfig(`migration-fixtures-${variant}`),
      ...scope,
      dictionaries,
    };
    config = applyUserDataScenario(config);
    context = indexModule.createPipelineContext();

    const prepareStart = Bun.nanoseconds();
    search =
      runtime === "native-static"
        ? await prepareNativeStaticSearch({
            sourceRoot,
            variant,
            config,
            context,
          })
        : await indexModule.preparePipelineSearch({ config, context });
    prepareMs = elapsedMs(prepareStart);
    if (
      runtime === "native-static" &&
      WRITE_NATIVE_CONFIG_PATH.length > 0 &&
      search.nativeStaticConfig
    ) {
      writeFileSync(
        WRITE_NATIVE_CONFIG_PATH,
        JSON.stringify(search.nativeStaticConfig),
      );
    }
  }
  let nativeRewrite;
  if (usePrebuiltNativePackage) {
    nativeRewrite = describeNativeRewriteFromNativePackage(runtime);
  } else if (usePrebuiltNativeConfig && search.nativeStaticConfig) {
    nativeRewrite = describeNativeRewriteFromNativeConfig(
      search.nativeStaticConfig,
      runtime,
    );
  } else {
    nativeRewrite = describeNativeRewrite(config, search, runtime);
  }

  let runtimeRunner = null;
  if (runtime === "native-static" && nativePackageBuffer !== null) {
    runtimeRunner =
      createNativeStaticRunnerFromPackageBytes(nativePackageBuffer);
  } else if (runtime === "native-static" && nativeConfigBytes === null) {
    runtimeRunner = createNativeStaticRunner(search.nativeStaticConfig);
  } else if (runtime === "native-static") {
    runtimeRunner = createNativeStaticRunnerFromJsonBytes(nativeConfigBytes);
  }
  const nativePrepareMs = runtimeRunner?.prepareMs ?? 0;
  const nativeStringifyMs = runtimeRunner?.stringifyMs ?? 0;
  const nativeArtifactPrepareMs = runtimeRunner?.artifactPrepareMs ?? 0;
  const nativeArtifactBytes = runtimeRunner?.artifactBytes ?? 0;
  const nativePackagePrepareMs = runtimeRunner?.packagePrepareMs ?? 0;
  const nativePackageBytes = runtimeRunner?.packageBytes ?? 0;
  const nativeCachedPrepareMsByIteration =
    runtimeRunner?.cachedPrepareMsByIteration ?? [];
  const nativeCachedPrepareAvgMs =
    nativeCachedPrepareMsByIteration.length === 0
      ? 0
      : roundMs(
          nativeCachedPrepareMsByIteration.reduce(
            (sum, value) => sum + value,
            0,
          ) / nativeCachedPrepareMsByIteration.length,
        );

  const coldRun =
    runtimeRunner === null
      ? await runTypeScriptFixtureSweep({
          indexModule,
          config,
          context,
          fixtures,
        })
      : runNativeStaticFixtureSweep({ runner: runtimeRunner, fixtures });

  const warmRuns = [];
  for (let index = 0; index < WARM_ITERATIONS; index += 1) {
    warmRuns.push(
      runtimeRunner === null
        ? await runTypeScriptFixtureSweep({
            indexModule,
            config,
            context,
            fixtures,
          })
        : runNativeStaticFixtureSweep({ runner: runtimeRunner, fixtures }),
    );
  }

  const warmRunMs = roundMs(warmRuns.reduce((sum, run) => sum + run.ms, 0));
  const warmAvgMs =
    WARM_ITERATIONS === 0 ? 0 : roundMs(warmRunMs / WARM_ITERATIONS);
  const fixtureTimings = summarizeFixtureTimings(coldRun, warmRuns);
  const nativeDiagnostics =
    runtimeRunner === null
      ? null
      : collectNativeDiagnostics({ runner: runtimeRunner, fixtures });
  if (nativeDiagnostics !== null && PROFILE_REGEX_LABELS) {
    nativeDiagnostics.regexPrepareByLabel = profileNativeRegexPrepare(
      search.nativeStaticConfig,
    );
  }
  if (
    nativeDiagnostics !== null &&
    PROFILE_SCOPED_PREPARE &&
    !usePrebuiltNativeConfig
  ) {
    nativeDiagnostics.scopedPrepare = await profileScopedNativePrepare({
      sourceRoot,
      variant,
      baseConfig: config,
      fixtures,
    });
  }
  const snapshots = Object.fromEntries(
    coldRun.fixtures.map((fixture) => [fixture.fixture, fixture.snapshot]),
  );

  writeFileSync(
    resultPath,
    `${JSON.stringify({
      event: "fixture-migration-variant",
      variant,
      pipelineRuntime: runtime,
      nativeRewrite,
      fixtureCount: fixtures.length,
      warmIterations: WARM_ITERATIONS,
      timings: {
        importMs,
        dictionaryMs,
        prepareMs,
        nativeConfigReadMs,
        nativeConfigParseMs,
        nativePackageReadMs,
        nativeStringifyMs,
        nativeArtifactPrepareMs,
        nativeArtifactBytes,
        nativePackageCompressed,
        nativePackagePrepareMs,
        nativePackageBytes,
        nativePrepareMs,
        nativeCachedPrepareMsByIteration,
        nativeCachedPrepareAvgMs,
        coldRunMs: coldRun.ms,
        coldPipelineMs: roundMs(
          dictionaryMs +
            prepareMs +
            nativeConfigReadMs +
            nativeStringifyMs +
            nativePrepareMs +
            coldRun.ms,
        ),
        coldTotalMs: roundMs(
          importMs +
            dictionaryMs +
            prepareMs +
            nativeConfigReadMs +
            nativeStringifyMs +
            nativePrepareMs +
            coldRun.ms,
        ),
        warmRunMsByIteration: warmRuns.map((run) => run.ms),
        warmRunMs,
        warmAvgMs,
      },
      nativeDiagnostics,
      fixtureTimings,
      fixtures: coldRun.fixtures.map(
        ({ fixture, ms, entityCount, redactedTextLength }) => ({
          fixture,
          ms,
          entityCount,
          redactedTextLength,
        }),
      ),
      snapshots,
    })}\n`,
  );
}

async function prepareNativeStaticSearch({
  sourceRoot,
  variant,
  config,
  context,
}) {
  const module = await importSource(
    sourceRoot,
    "packages/anonymize/src/build-unified-search.ts",
    variant,
  );
  const buildNativeStaticSearchBundle = Reflect.get(
    Object(module),
    "buildNativeStaticSearchBundle",
  );
  if (typeof buildNativeStaticSearchBundle !== "function") {
    throw new TypeError("Native static search bundle builder is unavailable");
  }
  return buildNativeStaticSearchBundle(config, [], context);
}

async function runTypeScriptFixtureSweep({
  indexModule,
  config,
  context,
  fixtures,
}) {
  const sweepStart = Bun.nanoseconds();
  const results = [];

  for (const fixturePath of fixtures) {
    const fullText = readFileSync(fixturePath, "utf8").replaceAll("\r\n", "\n");
    const start = Bun.nanoseconds();
    const entities = await indexModule.runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context,
    });
    const ms = elapsedMs(start);
    const snapshot = toSnapshot(indexModule, fullText, entities, context);
    results.push({
      fixture: relative(FIXTURES_DIR, fixturePath),
      ms,
      entityCount: snapshot.entityCount,
      redactedTextLength: snapshot.redactedText.length,
      snapshot,
    });
  }

  return {
    ms: elapsedMs(sweepStart),
    fixtures: results,
  };
}

function runNativeStaticFixtureSweep({ runner, fixtures }) {
  const sweepStart = Bun.nanoseconds();
  const results = [];

  for (const fixturePath of fixtures) {
    const fullText = readFileSync(fixturePath, "utf8").replaceAll("\r\n", "\n");
    const start = Bun.nanoseconds();
    const result = runner.prepared.redactStaticEntities(fullText, undefined);
    const ms = elapsedMs(start);
    const snapshot = toNativeSnapshot(fullText, result);
    results.push({
      fixture: relative(FIXTURES_DIR, fixturePath),
      ms,
      entityCount: snapshot.entityCount,
      redactedTextLength: snapshot.redactedText.length,
      snapshot,
    });
  }

  return {
    ms: elapsedMs(sweepStart),
    fixtures: results,
  };
}

function collectNativeDiagnostics({ runner, fixtures }) {
  const fixtureDiagnostics = [];

  for (const fixturePath of fixtures) {
    const fullText = readFileSync(fixturePath, "utf8").replaceAll("\r\n", "\n");
    const report = JSON.parse(
      runner.prepared.redactStaticEntitiesDiagnosticsJson(fullText, undefined),
    );
    fixtureDiagnostics.push({
      fixture: relative(FIXTURES_DIR, fixturePath),
      stages: diagnosticStageSummaries(report.diagnostics.events),
    });
  }

  return {
    prepare: {
      stages: diagnosticStageSummaries(runner.prepareDiagnostics.events),
      topStages: topDiagnosticStages(
        diagnosticStageSummaries(runner.prepareDiagnostics.events),
      ),
    },
    cachedPrepare:
      runner.cachedPrepareDiagnostics === null
        ? null
        : {
            stages: diagnosticStageSummaries(
              runner.cachedPrepareDiagnostics.events,
            ),
            topStages: topDiagnosticStages(
              diagnosticStageSummaries(runner.cachedPrepareDiagnostics.events),
            ),
          },
    run: summarizeFixtureDiagnostics(fixtureDiagnostics),
  };
}

function summarizeFixtureDiagnostics(fixtureDiagnostics) {
  const stageBuckets = new Map();
  const byFixture = [];

  for (const fixture of fixtureDiagnostics) {
    let fixtureElapsedMs = 0;
    for (const stage of fixture.stages) {
      fixtureElapsedMs += stage.elapsedMs ?? 0;
      const bucket = stageBuckets.get(stage.stage) ?? {
        stage: stage.stage,
        elapsedMs: [],
        count: 0,
      };
      if (typeof stage.elapsedMs === "number") {
        bucket.elapsedMs.push(stage.elapsedMs);
      }
      bucket.count += stage.count ?? 0;
      stageBuckets.set(stage.stage, bucket);
    }
    byFixture.push({
      fixture: fixture.fixture,
      elapsedMs: roundMs(fixtureElapsedMs),
      topStages: topDiagnosticStages(fixture.stages).slice(0, 5),
    });
  }

  const stages = [...stageBuckets.values()]
    .map((bucket) => ({
      stage: bucket.stage,
      calls: bucket.elapsedMs.length,
      totalMs: roundMs(bucket.elapsedMs.reduce((sum, ms) => sum + ms, 0)),
      avgMs:
        bucket.elapsedMs.length === 0
          ? 0
          : roundMs(
              bucket.elapsedMs.reduce((sum, ms) => sum + ms, 0) /
                bucket.elapsedMs.length,
            ),
      p50Ms: percentile(
        bucket.elapsedMs.toSorted((a, b) => a - b),
        0.5,
      ),
      p95Ms: percentile(
        bucket.elapsedMs.toSorted((a, b) => a - b),
        0.95,
      ),
      maxMs: percentile(
        bucket.elapsedMs.toSorted((a, b) => a - b),
        1,
      ),
      count: bucket.count,
    }))
    .sort((left, right) => right.totalMs - left.totalMs);

  return {
    stages,
    topStages: stages.slice(0, 10),
    topFixtures: byFixture
      .toSorted((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 10),
    byFixture,
  };
}

function diagnosticStageSummaries(events) {
  return events
    .filter((event) => event.kind === "stage-summary")
    .map((event) => ({
      stage: event.stage,
      count: event.count ?? 0,
      elapsedMs:
        typeof event.elapsed_us === "number"
          ? roundMs(event.elapsed_us / 1_000)
          : null,
      inputBytes: event.input_bytes ?? null,
    }));
}

function topDiagnosticStages(stages) {
  return stages
    .filter((stage) => typeof stage.elapsedMs === "number")
    .toSorted((left, right) => right.elapsedMs - left.elapsedMs);
}

function toSnapshot(indexModule, fullText, entities, context) {
  const sorted = entities.toSorted(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label) ||
      left.text.localeCompare(right.text),
  );
  const counts = {};
  for (const entity of sorted) {
    counts[entity.label] = (counts[entity.label] ?? 0) + 1;
  }

  const redacted = indexModule.redactText(fullText, sorted, undefined, context);

  return {
    entityCount: sorted.length,
    counts,
    entities: sorted.map(({ start, end, label, text, source }) => ({
      start,
      end,
      byteStart: utf16OffsetToUtf8ByteOffset(fullText, start),
      byteEnd: utf16OffsetToUtf8ByteOffset(fullText, end),
      label,
      text,
      source,
    })),
    redactedText: redacted.redactedText,
  };
}

function toNativeSnapshot(fullText, result) {
  const entities = result.resolvedEntities.toSorted(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label) ||
      left.text.localeCompare(right.text),
  );
  const counts = {};
  for (const entity of entities) {
    counts[entity.label] = (counts[entity.label] ?? 0) + 1;
  }

  return {
    entityCount: entities.length,
    counts,
    entities: entities.map(({ start, end, label, text, source }) => ({
      start,
      end,
      byteStart: utf16OffsetToUtf8ByteOffset(fullText, start),
      byteEnd: utf16OffsetToUtf8ByteOffset(fullText, end),
      label,
      text,
      source,
    })),
    redactedText: result.redaction.redactedText,
  };
}

function compareSnapshots(baseline, candidate) {
  const mismatches = [];
  const fixtureNames = new Set([
    ...Object.keys(baseline.snapshots),
    ...Object.keys(candidate.snapshots),
  ]);

  for (const fixture of [...fixtureNames].sort()) {
    const expected = baseline.snapshots[fixture];
    const actual = candidate.snapshots[fixture];
    if (snapshotsAreEquivalent(expected, actual)) {
      continue;
    }
    mismatches.push(describeMismatch(fixture, expected, actual));
  }

  return {
    event: "fixture-migration-parity",
    baseline: baseline.variant,
    candidate: candidate.variant,
    equal: mismatches.length === 0,
    acceptedEqual: mismatches.every(
      (mismatch) => mismatch.acceptedReason !== null,
    ),
    mismatchSummary: mismatchSummary(mismatches),
    fixtureCount: fixtureNames.size,
    mismatches,
    timingComparison: timingComparison(baseline, candidate),
    nativeRewrite: {
      baseline: baseline.nativeRewrite,
      candidate: candidate.nativeRewrite,
    },
  };
}

function mismatchSummary(mismatches) {
  const byCategory = {};
  let materialMismatchCount = 0;
  let redactionMismatchCount = 0;
  let sourceOnlyMismatchCount = 0;
  let acceptedMismatchCount = 0;
  let unexplainedMismatchCount = 0;
  let unexplainedMaterialMismatchCount = 0;
  let unexplainedRedactionMismatchCount = 0;

  for (const mismatch of mismatches) {
    const category = mismatch.category ?? mismatch.kind;
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    const accepted = mismatch.acceptedReason !== null;
    if (accepted) {
      acceptedMismatchCount += 1;
    } else {
      unexplainedMismatchCount += 1;
    }
    if (mismatch.sourceAgnosticEqual !== true) {
      materialMismatchCount += 1;
      if (!accepted) {
        unexplainedMaterialMismatchCount += 1;
      }
    }
    if (mismatch.redactedTextEqual === false) {
      redactionMismatchCount += 1;
      if (!accepted) {
        unexplainedRedactionMismatchCount += 1;
      }
    }
    if (
      mismatch.redactedTextEqual &&
      mismatch.sourceOnlyCount > 0 &&
      Object.keys(mismatch.candidateExtraByLabel ?? {}).length === 0 &&
      Object.keys(mismatch.candidateMissingByLabel ?? {}).length === 0
    ) {
      sourceOnlyMismatchCount += 1;
    }
  }

  return {
    strictMismatchCount: mismatches.length,
    materialMismatchCount,
    redactionMismatchCount,
    sourceOnlyMismatchCount,
    acceptedMismatchCount,
    unexplainedMismatchCount,
    unexplainedMaterialMismatchCount,
    unexplainedRedactionMismatchCount,
    byCategory,
  };
}

function snapshotsAreEquivalent(expected, actual) {
  if (expected === undefined || actual === undefined) {
    return false;
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return true;
  }
  return (
    expected.redactedText === actual.redactedText &&
    JSON.stringify(byteNormalizedSnapshot(expected)) ===
      JSON.stringify(byteNormalizedSnapshot(actual))
  );
}

function describeMismatch(fixture, expected, actual) {
  if (expected === undefined || actual === undefined) {
    return {
      fixture,
      kind: expected === undefined ? "missing-baseline" : "missing-candidate",
    };
  }

  const firstEntityDiff = firstDifferentIndex(
    expected.entities,
    actual.entities,
  );
  const expectedByteSnapshot = byteNormalizedSnapshot(expected);
  const actualByteSnapshot = byteNormalizedSnapshot(actual);
  const byteNormalizedEqual =
    JSON.stringify(expectedByteSnapshot) === JSON.stringify(actualByteSnapshot);
  const sourceAgnosticEqual =
    JSON.stringify(sourceAgnosticSnapshot(expectedByteSnapshot)) ===
    JSON.stringify(sourceAgnosticSnapshot(actualByteSnapshot));
  const firstByteEntityDiff = firstDifferentIndex(
    expectedByteSnapshot.entities,
    actualByteSnapshot.entities,
  );
  const category = mismatchCategory(expected, actual);

  const mismatch = {
    fixture,
    kind: "snapshot-mismatch",
    category: category.kind,
    entityCount: {
      baseline: expected.entityCount,
      candidate: actual.entityCount,
    },
    counts: {
      baseline: expected.counts,
      candidate: actual.counts,
    },
    redactedTextEqual: expected.redactedText === actual.redactedText,
    byteNormalizedEqual,
    sourceAgnosticEqual,
    sourceOnlyCount: category.sourceOnlyCount,
    candidateExtraByLabel: category.candidateExtraByLabel,
    candidateMissingByLabel: category.candidateMissingByLabel,
    candidateExtra: category.candidateExtra,
    candidateMissing: category.candidateMissing,
    firstCandidateExtra: category.firstCandidateExtra,
    firstCandidateMissing: category.firstCandidateMissing,
    firstEntityDiff:
      firstEntityDiff === -1
        ? null
        : {
            index: firstEntityDiff,
            baseline: expected.entities.at(firstEntityDiff) ?? null,
            candidate: actual.entities.at(firstEntityDiff) ?? null,
          },
    firstByteEntityDiff:
      firstByteEntityDiff === -1
        ? null
        : {
            index: firstByteEntityDiff,
            baseline:
              expectedByteSnapshot.entities.at(firstByteEntityDiff) ?? null,
            candidate:
              actualByteSnapshot.entities.at(firstByteEntityDiff) ?? null,
          },
  };
  return {
    ...mismatch,
    acceptedReason: acceptedMismatchReason(mismatch),
  };
}

function acceptedMismatchReason(mismatch) {
  if (mismatch.sourceAgnosticEqual === true) {
    return "source-only";
  }
  const accepted = ACCEPTED_NATIVE_STATIC_DELTAS.get(mismatch.fixture);
  if (accepted === undefined) {
    return null;
  }
  if (
    entitySummariesEqual(mismatch.candidateExtra, accepted.candidateExtra) &&
    entitySummariesEqual(mismatch.candidateMissing, accepted.candidateMissing)
  ) {
    return accepted.reason;
  }
  return null;
}

function entitySummariesEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function mismatchCategory(expected, actual) {
  const expectedByteEntities = byteNormalizedSnapshot(expected).entities;
  const actualByteEntities = byteNormalizedSnapshot(actual).entities;
  const redactedTextEqual = expected.redactedText === actual.redactedText;
  const entitySetEqual =
    JSON.stringify(expectedByteEntities) === JSON.stringify(actualByteEntities);
  if (redactedTextEqual && entitySetEqual) {
    return emptyMismatchCategory("metadata-only");
  }

  const expectedSpanLabel = countEntitiesByKey(
    expectedByteEntities,
    entitySpanLabelKey,
  );
  const actualSpanLabel = countEntitiesByKey(
    actualByteEntities,
    entitySpanLabelKey,
  );
  if (mapsEqual(expectedSpanLabel, actualSpanLabel)) {
    return {
      ...sourceDriftCategory(expectedByteEntities, actualByteEntities),
      kind: redactedTextEqual ? "text-or-source" : "span-label-only",
    };
  }

  const expectedContent = countEntitiesByKey(
    expectedByteEntities,
    entityContentKey,
  );
  const actualContent = countEntitiesByKey(
    actualByteEntities,
    entityContentKey,
  );
  if (mapsEqual(expectedContent, actualContent)) {
    return {
      ...sourceDriftCategory(expectedByteEntities, actualByteEntities),
      kind: redactedTextEqual ? "source-only" : "source-or-order",
    };
  }

  const delta = entityDelta(expectedByteEntities, actualByteEntities);
  return {
    kind: delta.missing.length === 0 ? "candidate-extra" : "coverage-drift",
    sourceOnlyCount: sourceDriftCategory(
      expectedByteEntities,
      actualByteEntities,
    ).sourceOnlyCount,
    candidateExtraByLabel: countByLabel(delta.extra),
    candidateMissingByLabel: countByLabel(delta.missing),
    candidateExtra: delta.extra.map(entitySummary),
    candidateMissing: delta.missing.map(entitySummary),
    firstCandidateExtra: entitySummary(delta.extra.at(0)),
    firstCandidateMissing: entitySummary(delta.missing.at(0)),
  };
}

function emptyMismatchCategory(kind) {
  return {
    kind,
    sourceOnlyCount: 0,
    candidateExtraByLabel: {},
    candidateMissingByLabel: {},
    candidateExtra: [],
    candidateMissing: [],
    firstCandidateExtra: null,
    firstCandidateMissing: null,
  };
}

function sourceDriftCategory(expectedEntities, actualEntities) {
  const expectedByContent = groupEntitiesByKey(
    expectedEntities,
    entityContentKey,
  );
  const actualByContent = groupEntitiesByKey(actualEntities, entityContentKey);
  let sourceOnlyCount = 0;
  for (const [key, expectedGroup] of expectedByContent) {
    const actualGroup = actualByContent.get(key) ?? [];
    const expectedSources = expectedGroup.map((entity) => entity.source).sort();
    const actualSources = actualGroup.map((entity) => entity.source).sort();
    if (JSON.stringify(expectedSources) !== JSON.stringify(actualSources)) {
      sourceOnlyCount += Math.max(expectedGroup.length, actualGroup.length);
    }
  }
  return {
    ...emptyMismatchCategory("source-only"),
    sourceOnlyCount,
  };
}

function entityDelta(expectedEntities, actualEntities) {
  const expectedCounts = countEntitiesByKey(expectedEntities, entityContentKey);
  const actualCounts = countEntitiesByKey(actualEntities, entityContentKey);

  return {
    missing: takeEntityDelta(expectedEntities, expectedCounts, actualCounts),
    extra: takeEntityDelta(actualEntities, actualCounts, expectedCounts),
  };
}

function takeEntityDelta(entities, ownCounts, otherCounts) {
  const remaining = new Map();
  for (const [key, ownCount] of ownCounts) {
    const diff = ownCount - (otherCounts.get(key) ?? 0);
    if (diff > 0) {
      remaining.set(key, diff);
    }
  }

  const delta = [];
  for (const entity of entities) {
    const key = entityContentKey(entity);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) {
      continue;
    }
    delta.push(entity);
    remaining.set(key, count - 1);
  }
  return delta;
}

function entityContentKey(entity) {
  return [entity.start, entity.end, entity.label, entity.text].join("\u0000");
}

function entitySpanLabelKey(entity) {
  return [entity.start, entity.end, entity.label].join("\u0000");
}

function countEntitiesByKey(entities, keyFn) {
  const counts = new Map();
  for (const entity of entities) {
    const key = keyFn(entity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function groupEntitiesByKey(entities, keyFn) {
  const groups = new Map();
  for (const entity of entities) {
    const key = keyFn(entity);
    const group = groups.get(key) ?? [];
    group.push(entity);
    groups.set(key, group);
  }
  return groups;
}

function mapsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function countByLabel(entities) {
  const counts = {};
  for (const entity of entities) {
    counts[entity.label] = (counts[entity.label] ?? 0) + 1;
  }
  return counts;
}

function entitySummary(entity) {
  if (!entity) {
    return null;
  }
  return {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    source: entity.source,
  };
}

function byteNormalizedSnapshot(snapshot) {
  const entities = snapshot.entities
    .map(({ byteStart, byteEnd, label, text, source }) => ({
      start: byteStart,
      end: byteEnd,
      label,
      text,
      source,
    }))
    .toSorted(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.label.localeCompare(right.label) ||
        left.text.localeCompare(right.text),
    );

  return {
    entityCount: snapshot.entityCount,
    counts: snapshot.counts,
    entities,
    redactedText: snapshot.redactedText,
  };
}

function sourceAgnosticSnapshot(snapshot) {
  return {
    ...snapshot,
    entities: snapshot.entities.map(({ source: _source, ...entity }) => entity),
  };
}

function timingComparison(baseline, candidate) {
  return {
    coldPipelineSpeedup: speedup(
      baseline.timings.coldPipelineMs,
      candidate.timings.coldPipelineMs,
    ),
    warmAvgSpeedup: speedup(
      baseline.timings.warmAvgMs,
      candidate.timings.warmAvgMs,
    ),
    baseline: baseline.timings,
    candidate: candidate.timings,
  };
}

function speedup(baselineMs, candidateMs) {
  if (candidateMs <= 0) {
    return null;
  }
  return roundMs(baselineMs / candidateMs);
}

function printVariantSummary(result) {
  console.log(
    JSON.stringify({
      event: result.event,
      variant: result.variant,
      pipelineRuntime: result.pipelineRuntime,
      nativeRewrite: result.nativeRewrite,
      fixtureCount: result.fixtureCount,
      warmIterations: result.warmIterations,
      timings: result.timings,
      nativeDiagnostics: result.nativeDiagnostics,
      fixtureTimings: result.fixtureTimings,
      fixtures: result.fixtures,
    }),
  );
}

function describeNativeRewrite(config, search, runtime) {
  const tsSliceLengths = Object.fromEntries(
    Object.entries(search.slices).map(([name, slice]) => [
      name,
      sliceLength(slice),
    ]),
  );
  const nativeStaticConfig = search.nativeStaticConfig;
  const sliceLengths = nativeStaticConfig
    ? nativeSliceLengths(nativeStaticConfig, tsSliceLengths)
    : tsSliceLengths;
  const regexValidationSlots = countUnsupportedRegexValidationSlots(
    search.regexMeta,
    nativeStaticConfig,
  );
  const denyListSourceCounts = countDenyListSources(search.denyListData);
  const nativeSupported = nativeStaticConfig
    ? nativeStaticConfig.regex_patterns.length +
      nativeStaticConfig.custom_regex_patterns.length +
      nativeStaticConfig.literal_patterns.length
    : null;
  const unsupportedSearchSlots = [
    unsupportedSlot("regex", regexValidationSlots, "regex validators"),
    unsupportedSlot(
      "triggers",
      nativeStaticConfig ? 0 : sliceLengths.triggers,
      "trigger extraction",
    ),
    unsupportedSlot(
      "streetTypes",
      nativeStaticConfig ? 0 : tsSliceLengths.streetTypes,
      "address seeds",
    ),
  ].filter((slot) => slot.count > 0);
  const supportedSearchSlots =
    nativeSupported ??
    Math.max(0, sliceLengths.regex - regexValidationSlots) +
      sliceLengths.customRegex +
      denyListSourceCounts.customOnly +
      denyListSourceCounts.curated +
      sliceLengths.gazetteer +
      sliceLengths.countries;
  const totalSearchSlots = nativeSupported
    ? supportedSearchSlots +
      unsupportedSearchSlots.reduce((sum, slot) => sum + slot.count, 0)
    : Object.values(sliceLengths).reduce((sum, length) => sum + length, 0);
  const unsupportedPipelineStages = describeUnsupportedPipelineStages(
    config,
    search,
    runtime,
    nativeStaticConfig,
  );

  return {
    measuredInPipeline: runtime === "native-static",
    pipelineRuntime: runtime,
    fullPipelineNativeEligible:
      unsupportedSearchSlots.length === 0 &&
      unsupportedPipelineStages.length === 0,
    searchSlotCoverage: {
      supported: supportedSearchSlots,
      total: totalSearchSlots,
      ratio:
        totalSearchSlots === 0
          ? 1
          : roundMs(supportedSearchSlots / totalSearchSlots),
    },
    sliceLengths,
    unsupportedSearchSlots,
    unsupportedPipelineStages,
  };
}

function describeNativeRewriteFromNativeConfig(nativeStaticConfig, runtime) {
  const supportedSearchSlots =
    nativeStaticConfig.regex_patterns.length +
    nativeStaticConfig.custom_regex_patterns.length +
    nativeStaticConfig.literal_patterns.length;
  const sliceLengths = nativeSliceLengths(nativeStaticConfig, {});

  return {
    measuredInPipeline: runtime === "native-static",
    pipelineRuntime: runtime,
    fullPipelineNativeEligible: false,
    searchSlotCoverage: {
      supported: supportedSearchSlots,
      total: supportedSearchSlots,
      ratio: 1,
    },
    sliceLengths,
    unsupportedSearchSlots: [],
    unsupportedPipelineStages: ["prebuilt-config-summary-only"],
  };
}

function describeNativeRewriteFromNativePackage(runtime) {
  return {
    measuredInPipeline: runtime === "native-static",
    pipelineRuntime: runtime,
    fullPipelineNativeEligible: false,
    searchSlotCoverage: {
      supported: 0,
      total: 0,
      ratio: 1,
    },
    sliceLengths: {
      regex: 0,
      customRegex: 0,
      legalForms: 0,
      triggers: 0,
      denyList: 0,
      streetTypes: 0,
      gazetteer: 0,
      countries: 0,
    },
    unsupportedSearchSlots: [],
    unsupportedPipelineStages: ["prebuilt-package-summary-only"],
  };
}

function nativeSliceLengths(nativeStaticConfig, fallbackSliceLengths) {
  const slices = nativeStaticConfig.slices ?? {};
  return {
    regex: sliceLength(slices.regex),
    customRegex: sliceLength(slices.custom_regex),
    legalForms: sliceLength(slices.legal_forms),
    triggers: sliceLength(slices.triggers),
    denyList: sliceLength(slices.deny_list),
    streetTypes: nativeStaticConfig
      ? sliceLength(slices.street_types)
      : fallbackSliceLengths.streetTypes,
    gazetteer: sliceLength(slices.gazetteer),
    countries: sliceLength(slices.countries),
  };
}

function describeUnsupportedPipelineStages(
  config,
  search,
  runtime,
  nativeStaticConfig,
) {
  const stages = [];
  const nativeRuntime = runtime === "native-static" && nativeStaticConfig;
  if (config.enableLegalForms && !nativeRuntime) {
    stages.push("legal-forms-v2");
  }
  if (config.enableTriggerPhrases && !nativeRuntime) {
    stages.push("triggers");
  }
  if (config.enableNameCorpus) {
    stages.push(
      config.enableDenyList ? "name-corpus-supplemental" : "name-corpus",
    );
  }
  if (config.enableNer) {
    stages.push("ner");
  }
  if (config.enableZoneClassification && !nativeRuntime) {
    stages.push("zone-classification");
  }
  if (config.enableCoreference && !nativeRuntime) {
    stages.push("coreference");
  }
  if (!nativeRuntime && sliceLength(search.slices.streetTypes) > 0) {
    stages.push("address-seeds");
  }

  if (!nativeRuntime) {
    stages.push("signatures");
  }
  return stages;
}

function countUnsupportedRegexValidationSlots(regexMeta, nativeStaticConfig) {
  const nativeValidatorIds = new Set(
    (nativeStaticConfig?.regex_meta ?? [])
      .map((meta) => meta.validator_id)
      .filter((validatorId) => typeof validatorId === "string"),
  );
  let count = 0;
  for (const meta of regexMeta) {
    if (!regexMetaRequiresValidation(meta)) {
      continue;
    }
    if (meta.validatorId && nativeValidatorIds.has(meta.validatorId)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function regexMetaRequiresValidation(meta) {
  return meta?.validator !== undefined || meta?.requiresValidation === true;
}

function countDenyListSources(denyListData) {
  if (!denyListData) {
    return { customOnly: 0, curated: 0 };
  }

  let customOnly = 0;
  let curated = 0;
  for (const sources of denyListData.sources) {
    const sourceList = Array.isArray(sources) ? sources : [sources];
    if (
      sourceList.length > 0 &&
      sourceList.every((source) => source === "custom-deny-list")
    ) {
      customOnly += 1;
    } else {
      curated += 1;
    }
  }

  return { customOnly, curated };
}

function unsupportedSlot(slice, count, reason) {
  return { slice, count, reason };
}

function sliceLength(slice) {
  return Math.max(0, Number(slice.end ?? 0) - Number(slice.start ?? 0));
}

function summarizeFixtureTimings(coldRun, warmRuns) {
  return {
    cold: summarizeRunFixtures(coldRun.fixtures),
    warm:
      warmRuns.length === 0
        ? null
        : summarizeRunFixtures(warmRuns.flatMap((run) => run.fixtures)),
    byFixture: coldRun.fixtures.map((coldFixture, index) => {
      const warmMs = warmRuns
        .map((run) => run.fixtures.at(index)?.ms)
        .filter((ms) => typeof ms === "number");
      return {
        fixture: coldFixture.fixture,
        coldMs: coldFixture.ms,
        warmAvgMs:
          warmMs.length === 0
            ? null
            : roundMs(warmMs.reduce((sum, ms) => sum + ms, 0) / warmMs.length),
      };
    }),
  };
}

function summarizeRunFixtures(fixtures) {
  const values = fixtures.map((fixture) => fixture.ms).sort((a, b) => a - b);
  return {
    minMs: percentile(values, 0),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * fraction) - 1),
  );
  return roundMs(values[index]);
}

function firstDifferentIndex(left, right) {
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    if (JSON.stringify(left.at(index)) !== JSON.stringify(right.at(index))) {
      return index;
    }
  }
  return -1;
}

function utf16OffsetToUtf8ByteOffset(text, offset) {
  return Buffer.byteLength(text.slice(0, offset), "utf8");
}

function discoverFixtures(fixturesDir) {
  const paths = [];
  for (const language of readdirSync(fixturesDir)) {
    const languageDir = join(fixturesDir, language);
    for (const file of readdirSync(languageDir)) {
      if (file.endsWith(".txt")) {
        paths.push(join(languageDir, file));
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function ensureGitRef(ref) {
  const verify = spawnSync("git", ["rev-parse", "--verify", `${ref}^{tree}`], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  if (verify.status === 0) {
    return;
  }

  if (ref === "origin/main") {
    runCommand("git", ["fetch", "origin", "main", "--depth=1"]);
    const retry = spawnSync("git", ["rev-parse", "--verify", `${ref}^{tree}`], {
      cwd: ROOT_DIR,
      encoding: "utf8",
    });
    if (retry.status === 0) {
      return;
    }
  }

  throw new Error(`Cannot resolve baseline ref: ${ref}`);
}

function materializeBaselineRef(ref, tempRoot) {
  ensureGitRef(ref);
  return materializeGitRef(ref, tempRoot);
}

function materializeGitRef(ref, tempRoot) {
  const outputDir = join(tempRoot, "baseline");
  mkdirSync(outputDir, { recursive: true });

  const archive = spawnSync("git", ["archive", "--format=tar", ref], {
    cwd: ROOT_DIR,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(
      `git archive failed for ${ref}: ${archive.stderr.toString()}`,
    );
  }

  const extract = spawnSync("tar", ["-x", "-C", outputDir], {
    input: archive.stdout,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (extract.status !== 0) {
    throw new Error(`tar extraction failed: ${extract.stderr.toString()}`);
  }

  return outputDir;
}

function createNativeStaticRunner(nativeStaticConfig) {
  if (!nativeStaticConfig) {
    throw new Error("Native static runtime requires nativeStaticConfig");
  }

  const stringifyStart = Bun.nanoseconds();
  const configJson = JSON.stringify(nativeStaticConfig);
  const stringifyMs = elapsedMs(stringifyStart);
  return createNativeStaticRunnerFromJson(configJson, stringifyMs);
}

function createNativeStaticRunnerFromJson(configJson, stringifyMs = 0) {
  const native = loadNativeAdapter();
  const configBytes = Buffer.from(configJson);
  const packageStart = Bun.nanoseconds();
  const packageBytes = NATIVE_PREPARED_PACKAGE
    ? prepareNativePackageBytes(native, configBytes)
    : null;
  writeNativePackageIfRequested(packageBytes);
  const packagePrepareMs = packageBytes === null ? 0 : elapsedMs(packageStart);
  const artifactStart = Bun.nanoseconds();
  const artifactBytes = NATIVE_PREPARED_ARTIFACTS
    ? native.prepareStaticSearchArtifactsBytes(configBytes)
    : null;
  const artifactPrepareMs =
    artifactBytes === null ? 0 : elapsedMs(artifactStart);
  const prepare = () => {
    if (packageBytes !== null) {
      return native.NativePreparedSearch.fromPreparedPackageBytes(packageBytes);
    }
    if (artifactBytes !== null) {
      return native.NativePreparedSearch.fromConfigJsonAndArtifactBytes(
        configBytes,
        artifactBytes,
      );
    }
    return new native.NativePreparedSearch(configJson);
  };
  const prepareStart = Bun.nanoseconds();
  const prepared = prepare();
  const prepareMs = elapsedMs(prepareStart);
  const prepareDiagnostics = JSON.parse(prepared.prepareDiagnosticsJson());
  const cachedPrepareMsByIteration = [];
  let cachedPrepareDiagnostics = null;
  for (let index = 0; index < CACHED_PREPARE_ITERATIONS; index += 1) {
    const cachedPrepareStart = Bun.nanoseconds();
    const cachedPrepared = prepare();
    cachedPrepareMsByIteration.push(elapsedMs(cachedPrepareStart));
    cachedPrepareDiagnostics = JSON.parse(
      cachedPrepared.prepareDiagnosticsJson(),
    );
  }
  return {
    prepared,
    prepareDiagnostics,
    cachedPrepareDiagnostics,
    cachedPrepareMsByIteration,
    configBytes: Buffer.byteLength(configJson, "utf8"),
    artifactBytes: artifactBytes?.byteLength ?? 0,
    artifactPrepareMs,
    packageBytes: packageBytes?.byteLength ?? 0,
    packagePrepareMs,
    stringifyMs,
    prepareMs,
  };
}

function createNativeStaticRunnerFromJsonBytes(configBytes) {
  const native = loadNativeAdapter();
  const packageStart = Bun.nanoseconds();
  const packageBytes = NATIVE_PREPARED_PACKAGE
    ? prepareNativePackageBytes(native, configBytes)
    : null;
  writeNativePackageIfRequested(packageBytes);
  const packagePrepareMs = packageBytes === null ? 0 : elapsedMs(packageStart);
  const artifactStart = Bun.nanoseconds();
  const artifactBytes = NATIVE_PREPARED_ARTIFACTS
    ? native.prepareStaticSearchArtifactsBytes(configBytes)
    : null;
  const artifactPrepareMs =
    artifactBytes === null ? 0 : elapsedMs(artifactStart);
  const prepare = (bytes) => {
    if (packageBytes !== null) {
      return native.NativePreparedSearch.fromPreparedPackageBytes(packageBytes);
    }
    if (artifactBytes !== null) {
      return native.NativePreparedSearch.fromConfigJsonAndArtifactBytes(
        bytes,
        artifactBytes,
      );
    }
    const factory = Reflect.get(
      native.NativePreparedSearch,
      "fromConfigJsonBytes",
    );
    if (typeof factory === "function") {
      return factory.call(native.NativePreparedSearch, bytes);
    }
    return new native.NativePreparedSearch(bytes.toString("utf8"));
  };
  const prepareStart = Bun.nanoseconds();
  const prepared = prepare(configBytes);
  const prepareMs = elapsedMs(prepareStart);
  const prepareDiagnostics = JSON.parse(prepared.prepareDiagnosticsJson());
  const cachedPrepareMsByIteration = [];
  let cachedPrepareDiagnostics = null;
  for (let index = 0; index < CACHED_PREPARE_ITERATIONS; index += 1) {
    const cachedPrepareStart = Bun.nanoseconds();
    const cachedPrepared = prepare(configBytes);
    cachedPrepareMsByIteration.push(elapsedMs(cachedPrepareStart));
    cachedPrepareDiagnostics = JSON.parse(
      cachedPrepared.prepareDiagnosticsJson(),
    );
  }
  return {
    prepared,
    prepareDiagnostics,
    cachedPrepareDiagnostics,
    cachedPrepareMsByIteration,
    configBytes: configBytes.byteLength,
    artifactBytes: artifactBytes?.byteLength ?? 0,
    artifactPrepareMs,
    packageBytes: packageBytes?.byteLength ?? 0,
    packagePrepareMs,
    stringifyMs: 0,
    prepareMs,
  };
}

function createNativeStaticRunnerFromPackageBytes(packageBytes) {
  const native = loadNativeAdapter();
  const prepare = () =>
    native.NativePreparedSearch.fromPreparedPackageBytes(packageBytes);
  const prepareStart = Bun.nanoseconds();
  const prepared = prepare();
  const prepareMs = elapsedMs(prepareStart);
  const prepareDiagnostics = JSON.parse(prepared.prepareDiagnosticsJson());
  const cachedPrepareMsByIteration = [];
  let cachedPrepareDiagnostics = null;
  for (let index = 0; index < CACHED_PREPARE_ITERATIONS; index += 1) {
    const cachedPrepareStart = Bun.nanoseconds();
    const cachedPrepared = prepare();
    cachedPrepareMsByIteration.push(elapsedMs(cachedPrepareStart));
    cachedPrepareDiagnostics = JSON.parse(
      cachedPrepared.prepareDiagnosticsJson(),
    );
  }
  return {
    prepared,
    prepareDiagnostics,
    cachedPrepareDiagnostics,
    cachedPrepareMsByIteration,
    configBytes: 0,
    artifactBytes: 0,
    artifactPrepareMs: 0,
    packageBytes: packageBytes.byteLength,
    packagePrepareMs: 0,
    stringifyMs: 0,
    prepareMs,
  };
}

function writeNativePackageIfRequested(packageBytes) {
  if (packageBytes !== null && WRITE_NATIVE_PACKAGE_PATH.length > 0) {
    writeFileSync(WRITE_NATIVE_PACKAGE_PATH, packageBytes);
  }
}

function profileNativeRegexPrepare(nativeStaticConfig) {
  if (!nativeStaticConfig) {
    return null;
  }

  const native = loadNativeAdapter();
  const regexCount = sliceLength(nativeStaticConfig.slices?.regex);
  const regexMeta = nativeStaticConfig.regex_meta ?? [];
  const labels = [...new Set(regexMeta.map((meta) => meta.label))].sort(
    (left, right) => left.localeCompare(right),
  );
  const labelCounts = Object.fromEntries(
    labels.map((label) => [
      label,
      regexMeta.filter((meta) => meta.label === label).length,
    ]),
  );

  return {
    regexCount,
    labelCounts,
    only: labels.map((label) =>
      measureNativeConfigPrepare(
        native.NativePreparedSearch,
        `only:${label}`,
        nativeRegexOnlyConfig(nativeStaticConfig, new Set([label])),
      ),
    ),
    without: labels.map((label) =>
      measureNativeConfigPrepare(
        native.NativePreparedSearch,
        `without:${label}`,
        nativeConfigWithRegexLabels(
          nativeStaticConfig,
          new Set([label]),
          false,
        ),
      ),
    ),
    withoutHotGroups: measureNativeConfigPrepare(
      native.NativePreparedSearch,
      "without:date+monetary amount",
      nativeConfigWithRegexLabels(
        nativeStaticConfig,
        new Set(["date", "monetary amount"]),
        false,
      ),
    ),
  };
}

async function profileScopedNativePrepare({
  sourceRoot,
  variant,
  baseConfig,
  fixtures,
}) {
  const module = await importSource(
    sourceRoot,
    "packages/anonymize/src/build-unified-search.ts",
    variant,
  );
  const buildNativeStaticSearchBundle = Reflect.get(
    Object(module),
    "buildNativeStaticSearchBundle",
  );
  if (typeof buildNativeStaticSearchBundle !== "function") {
    throw new TypeError("Native static search bundle builder is unavailable");
  }
  const contextModule = await importSource(
    sourceRoot,
    "packages/anonymize/src/context.ts",
    `${variant}:scoped-prepare`,
  );
  const createPipelineContext = Reflect.get(
    Object(contextModule),
    "createPipelineContext",
  );
  if (typeof createPipelineContext !== "function") {
    throw new TypeError("Pipeline context factory is unavailable");
  }

  const native = loadNativeAdapter();
  const languages = [
    ...new Set(fixtures.map((fixture) => fixtureLanguage(fixture))),
  ].sort((left, right) => left.localeCompare(right));

  const scopes = [];
  for (const language of languages) {
    const scopedConfig = applyFixtureLanguageScope(baseConfig, language);
    const buildStart = Bun.nanoseconds();
    const bundle = await buildNativeStaticSearchBundle(
      scopedConfig,
      [],
      createPipelineContext(),
    );
    const buildMs = elapsedMs(buildStart);
    const prepare = measureNativeConfigPrepare(
      native.NativePreparedSearch,
      language,
      bundle.nativeStaticConfig,
    );
    scopes.push({
      language,
      scope: fixtureLanguageScope(language),
      buildMs,
      ...prepare,
    });
  }

  return scopes;
}

function nativeConfigWithRegexLabels(config, labels, keepMatching) {
  const regexMeta = config.regex_meta ?? [];
  const regexPatterns = [];
  const nextMeta = [];
  for (const [index, meta] of regexMeta.entries()) {
    const matches = labels.has(meta.label);
    if (matches !== keepMatching) {
      continue;
    }
    regexPatterns.push(config.regex_patterns[index]);
    nextMeta.push(meta);
  }

  const oldRegexCount = regexMeta.length;
  const tail = config.regex_patterns.slice(oldRegexCount);
  const nextRegexCount = regexPatterns.length;
  const legalFormCount = sliceLength(config.slices?.legal_forms);
  const triggerCount = sliceLength(config.slices?.triggers);

  return {
    ...config,
    regex_patterns: [...regexPatterns, ...tail],
    regex_meta: nextMeta,
    slices: {
      ...config.slices,
      regex: { start: 0, end: nextRegexCount },
      legal_forms: {
        start: nextRegexCount,
        end: nextRegexCount + legalFormCount,
      },
      triggers: {
        start: nextRegexCount + legalFormCount,
        end: nextRegexCount + legalFormCount + triggerCount,
      },
    },
  };
}

function nativeRegexOnlyConfig(config, labels) {
  const regexMeta = config.regex_meta ?? [];
  const regexPatterns = [];
  const nextMeta = [];
  for (const [index, meta] of regexMeta.entries()) {
    if (!labels.has(meta.label)) {
      continue;
    }
    regexPatterns.push(config.regex_patterns[index]);
    nextMeta.push(meta);
  }

  return {
    ...config,
    regex_patterns: regexPatterns,
    regex_meta: nextMeta,
    literal_patterns: [],
    literal_patterns_from_deny_list_data: false,
    deny_list_data: undefined,
    gazetteer_data: undefined,
    country_data: undefined,
    trigger_data: undefined,
    legal_form_data: undefined,
    slices: {
      regex: { start: 0, end: regexPatterns.length },
      custom_regex: { start: 0, end: 0 },
      legal_forms: {
        start: regexPatterns.length,
        end: regexPatterns.length,
      },
      triggers: {
        start: regexPatterns.length,
        end: regexPatterns.length,
      },
      deny_list: { start: 0, end: 0 },
      street_types: { start: 0, end: 0 },
      gazetteer: { start: 0, end: 0 },
      countries: { start: 0, end: 0 },
    },
  };
}

function measureNativeConfigPrepare(NativePreparedSearch, name, config) {
  const stringifyStart = Bun.nanoseconds();
  const configJson = JSON.stringify(config);
  const stringifyMs = elapsedMs(stringifyStart);
  const prepareStart = Bun.nanoseconds();
  const prepared = new NativePreparedSearch(configJson);
  const prepareMs = elapsedMs(prepareStart);
  const diagnostics = JSON.parse(prepared.prepareDiagnosticsJson());
  const stages = diagnosticStageSummaries(diagnostics.events);

  return {
    name,
    configBytes: Buffer.byteLength(configJson, "utf8"),
    sliceLengths: nativeSliceLengths(config, {}),
    stringifyMs,
    prepareMs,
    topStages: topDiagnosticStages(stages).slice(0, 8),
  };
}

function fixtureLanguage(fixturePath) {
  return relative(FIXTURES_DIR, fixturePath).split(/[\\/]/)[0] ?? "und";
}

function applyFixtureLanguageScope(config, language) {
  return {
    ...config,
    ...fixtureLanguageScope(language),
  };
}

function fixtureLanguageScope(language) {
  switch (language) {
    case "cs":
      return {
        denyListCountries: ["CZ", "SK"],
        nameCorpusLanguages: ["cs", "sk"],
      };
    case "de":
      return {
        denyListCountries: ["DE", "AT", "CH"],
        nameCorpusLanguages: ["de"],
      };
    case "en":
      return {
        denyListCountries: ["US", "GB", "CA", "AU", "IE"],
        nameCorpusLanguages: ["en"],
      };
    default:
      return {};
  }
}

function contentLanguageScope() {
  if (CONTENT_LANGUAGE.length === 0) {
    return {};
  }

  return {
    language: CONTENT_LANGUAGE,
    ...fixtureLanguageScope(CONTENT_LANGUAGE),
  };
}

function applyUserDataScenario(config) {
  switch (USER_DATA_SCENARIO) {
    case "none":
      return config;
    case "sample":
      return withUserDataOverlay(config, {
        denyListCount: 50,
        regexCount: 5,
      });
    case "heavy":
      return withUserDataOverlay(config, {
        denyListCount: 5_000,
        regexCount: 50,
      });
    default:
      throw new Error(
        `ANONYMIZE_MIGRATION_USER_DATA_SCENARIO must be none, sample, or heavy; got ${USER_DATA_SCENARIO}`,
      );
  }
}

function withUserDataOverlay(config, { denyListCount, regexCount }) {
  return {
    ...config,
    customDenyList: [
      ...(config.customDenyList ?? []),
      ...generatedCustomDenyList(denyListCount),
    ],
    customRegexes: [
      ...(config.customRegexes ?? []),
      ...generatedCustomRegexes(regexCount),
    ],
  };
}

function generatedCustomDenyList(count) {
  return Array.from({ length: count }, (_, index) => ({
    value: `CustomerPrivateTerm${index.toString().padStart(5, "0")}`,
    label: index % 2 === 0 ? "organization" : "person",
    variants: [`Customer Private Term ${index.toString().padStart(5, "0")}`],
  }));
}

function generatedCustomRegexes(count) {
  return Array.from({ length: count }, (_, index) => ({
    pattern: `USR-${index.toString().padStart(4, "0")}-[A-Z]{2}\\d{4}`,
    label:
      index % 2 === 0 ? "registration number" : "tax identification number",
    score: 0.92,
  }));
}

function loadNativeAdapter() {
  const tempDir = mkdtempSync(join(tmpdir(), "stella-anonymize-fixture-napi-"));
  const napiPath = join(tempDir, "stella_anonymize_napi.node");
  copyFileSync(nativeLibraryPath("stella_anonymize_napi"), napiPath);
  const loaded = createRequire(import.meta.url)(napiPath);
  const NativePreparedSearch = Reflect.get(
    Object(loaded),
    "NativePreparedSearch",
  );
  const prepareStaticSearchArtifactsBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchArtifactsBytes",
  );
  const prepareStaticSearchPackageBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchPackageBytes",
  );
  const prepareStaticSearchCompressedPackageBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchCompressedPackageBytes",
  );
  if (
    typeof NativePreparedSearch !== "function" ||
    typeof prepareStaticSearchArtifactsBytes !== "function" ||
    typeof prepareStaticSearchPackageBytes !== "function" ||
    typeof prepareStaticSearchCompressedPackageBytes !== "function"
  ) {
    throw new TypeError("Native anonymize adapter exports are incomplete");
  }
  return {
    NativePreparedSearch,
    prepareStaticSearchArtifactsBytes,
    prepareStaticSearchPackageBytes,
    prepareStaticSearchCompressedPackageBytes,
  };
}

function prepareNativePackageBytes(native, configBytes) {
  if (NATIVE_COMPRESSED_PACKAGE) {
    return native.prepareStaticSearchCompressedPackageBytes(configBytes);
  }
  return native.prepareStaticSearchPackageBytes(configBytes);
}

function isCompressedNativePackage(packageBytes) {
  const header = packageBytes.subarray(0, 8).toString("ascii");
  return header === "ANONPKZ1" || header === "ANONCPZ1";
}

function nativeLibraryPath(name) {
  if (process.platform === "darwin") {
    return join(ROOT_DIR, "target", "release", `lib${name}.dylib`);
  }
  if (process.platform === "linux") {
    return join(ROOT_DIR, "target", "release", `lib${name}.so`);
  }
  return join(ROOT_DIR, "target", "release", `${name}.dll`);
}

function ensureNativeAdapterBuilt() {
  runCommand("cargo", [
    "build",
    "-p",
    "stella-anonymize-napi",
    "--release",
    "--locked",
  ]);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function validateRuntime(runtime) {
  if (runtime === "typescript" || runtime === "native-static") {
    return;
  }
  throw new Error(
    `ANONYMIZE_MIGRATION_CANDIDATE_RUNTIME must be typescript or native-static, got ${runtime}`,
  );
}

function importSource(sourceRoot, relativePath, variant) {
  const path = join(sourceRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing source file for ${variant}: ${path}`);
  }
  const url = pathToFileURL(path);
  url.searchParams.set("migrationVariant", variant);
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  return import(url.href);
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function stringListEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function elapsedMs(start) {
  return roundMs((Bun.nanoseconds() - start) / 1_000_000);
}

function roundMs(ms) {
  return Math.round(ms * 1_000) / 1_000;
}
