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

if (process.env.ANONYMIZE_MIGRATION_WORKER === "1") {
  await runWorker();
} else {
  await runCoordinator();
}

async function runCoordinator() {
  const fixtures = discoverFixtures(FIXTURES_DIR);
  if (fixtures.length === 0) {
    throw new Error(`No contract fixtures found in ${FIXTURES_DIR}`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "stella-anonymize-migration-"));

  try {
    let baseline = null;
    if (COMPARE_BASELINE) {
      ensureGitRef(BASELINE_REF);
      const baselineRoot = materializeGitRef(BASELINE_REF, tempRoot);
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

  const importStart = Bun.nanoseconds();
  const [indexModule, configModule, dictionaryModule] = await Promise.all([
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
  const importMs = elapsedMs(importStart);

  const dictionaryStart = Bun.nanoseconds();
  const dictionaries = await dictionaryModule.loadTestDictionaries();
  const dictionaryMs = elapsedMs(dictionaryStart);

  const config = {
    ...configModule.contractTestConfig(`migration-fixtures-${variant}`),
    dictionaries,
  };
  const context = indexModule.createPipelineContext();

  const prepareStart = Bun.nanoseconds();
  const search =
    runtime === "native-static"
      ? await prepareNativeStaticSearch({
          sourceRoot,
          variant,
          config,
          context,
        })
      : await indexModule.preparePipelineSearch({ config, context });
  const prepareMs = elapsedMs(prepareStart);
  const nativeRewrite = describeNativeRewrite(config, search, runtime);

  const runtimeRunner =
    runtime === "native-static"
      ? createNativeStaticRunner(search.nativeStaticConfig)
      : null;
  const nativePrepareMs = runtimeRunner?.prepareMs ?? 0;

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
        nativePrepareMs,
        coldRunMs: coldRun.ms,
        coldPipelineMs: roundMs(
          dictionaryMs + prepareMs + nativePrepareMs + coldRun.ms,
        ),
        coldTotalMs: roundMs(
          importMs + dictionaryMs + prepareMs + nativePrepareMs + coldRun.ms,
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
    const snapshot = toNativeSnapshot(result);
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
      label,
      text,
      source,
    })),
    redactedText: redacted.redactedText,
  };
}

function toNativeSnapshot(result) {
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
    if (JSON.stringify(expected) === JSON.stringify(actual)) {
      continue;
    }
    mismatches.push(describeMismatch(fixture, expected, actual));
  }

  return {
    event: "fixture-migration-parity",
    baseline: baseline.variant,
    candidate: candidate.variant,
    equal: mismatches.length === 0,
    fixtureCount: fixtureNames.size,
    mismatches,
    timingComparison: timingComparison(baseline, candidate),
    nativeRewrite: {
      baseline: baseline.nativeRewrite,
      candidate: candidate.nativeRewrite,
    },
  };
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

  return {
    fixture,
    kind: "snapshot-mismatch",
    entityCount: {
      baseline: expected.entityCount,
      candidate: actual.entityCount,
    },
    counts: {
      baseline: expected.counts,
      candidate: actual.counts,
    },
    redactedTextEqual: expected.redactedText === actual.redactedText,
    firstEntityDiff:
      firstEntityDiff === -1
        ? null
        : {
            index: firstEntityDiff,
            baseline: expected.entities.at(firstEntityDiff) ?? null,
            candidate: actual.entities.at(firstEntityDiff) ?? null,
          },
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
  const sliceLengths = Object.fromEntries(
    Object.entries(search.slices).map(([name, slice]) => [
      name,
      sliceLength(slice),
    ]),
  );
  const regexValidationSlots = countRegexValidationSlots(search.regexMeta);
  const denyListSourceCounts = countDenyListSources(search.denyListData);
  const nativeStaticConfig = search.nativeStaticConfig;
  const unsupportedSearchSlots = [
    unsupportedSlot("regex", regexValidationSlots, "regex validators"),
    unsupportedSlot("triggers", sliceLengths.triggers, "trigger extraction"),
    unsupportedSlot("streetTypes", sliceLengths.streetTypes, "address seeds"),
  ].filter((slot) => slot.count > 0);
  const supportedSearchSlots = nativeStaticConfig
    ? nativeStaticConfig.regex_patterns.length +
      nativeStaticConfig.custom_regex_patterns.length +
      nativeStaticConfig.literal_patterns.length
    : Math.max(0, sliceLengths.regex - regexValidationSlots) +
      sliceLengths.customRegex +
      denyListSourceCounts.customOnly +
      denyListSourceCounts.curated +
      sliceLengths.gazetteer +
      sliceLengths.countries;
  const totalSearchSlots = Object.values(sliceLengths).reduce(
    (sum, length) => sum + length,
    0,
  );
  const unsupportedPipelineStages = describeUnsupportedPipelineStages(
    config,
    search,
    denyListSourceCounts,
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

function describeUnsupportedPipelineStages(
  config,
  search,
  denyListSourceCounts,
) {
  const stages = [];
  if (config.enableLegalForms) {
    stages.push("legal-forms-v2");
  }
  if (config.enableTriggerPhrases) {
    stages.push("triggers");
  }
  if (config.enableNameCorpus) {
    stages.push(
      config.enableDenyList ? "name-corpus-supplemental" : "name-corpus",
    );
  }
  if (config.enableHotwordRules) {
    stages.push("hotword-rules");
  }
  if (config.enableZoneClassification) {
    stages.push("zone-classification");
  }
  if (config.enableConfidenceBoost) {
    stages.push("confidence-boost");
  }
  if (config.enableCoreference) {
    stages.push("coreference");
  }
  if (sliceLength(search.slices.streetTypes) > 0) {
    stages.push("address-seeds");
  }

  stages.push("signatures", "false-positive-filters", "final-extensions");
  return stages;
}

function countRegexValidationSlots(regexMeta) {
  return regexMeta.reduce(
    (count, meta) => count + (meta.requiresValidation === true ? 1 : 0),
    0,
  );
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

  const native = loadNativeAdapter();
  const prepareStart = Bun.nanoseconds();
  const prepared = new native.NativePreparedSearch(
    toNapiConfig(nativeStaticConfig),
  );
  const prepareMs = elapsedMs(prepareStart);
  const prepareDiagnostics = JSON.parse(prepared.prepareDiagnosticsJson());
  return {
    prepared,
    prepareDiagnostics,
    prepareMs,
  };
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
  if (typeof NativePreparedSearch !== "function") {
    throw new TypeError("Native anonymize adapter exports are incomplete");
  }
  return { NativePreparedSearch };
}

function toNapiConfig(config) {
  return {
    regexPatterns: config.regex_patterns.map(toNapiPattern),
    customRegexPatterns: config.custom_regex_patterns.map(toNapiPattern),
    literalPatterns: config.literal_patterns.map(toNapiPattern),
    regexOptions: toNapiOptions(config.regex_options),
    customRegexOptions: toNapiOptions(config.custom_regex_options),
    literalOptions: toNapiOptions(config.literal_options),
    slices: {
      regex: config.slices.regex,
      customRegex: config.slices.custom_regex,
      legalForms: config.slices.legal_forms,
      triggers: config.slices.triggers,
      denyList: config.slices.deny_list,
      streetTypes: config.slices.street_types,
      gazetteer: config.slices.gazetteer,
      countries: config.slices.countries,
    },
    regexMeta: config.regex_meta.map(toNapiRegexMeta),
    customRegexMeta: config.custom_regex_meta.map(toNapiRegexMeta),
    denyListData:
      config.deny_list_data === undefined
        ? undefined
        : {
            labels: config.deny_list_data.labels,
            customLabels: config.deny_list_data.custom_labels,
            originals: config.deny_list_data.originals,
            sources: config.deny_list_data.sources,
            filters:
              config.deny_list_data.filters === undefined
                ? undefined
                : toNapiDenyListFilters(config.deny_list_data.filters),
          },
    gazetteerData:
      config.gazetteer_data === undefined
        ? undefined
        : {
            labels: config.gazetteer_data.labels,
            isFuzzy: config.gazetteer_data.is_fuzzy,
          },
    countryData: config.country_data,
  };
}

function toNapiPattern(pattern) {
  return {
    kind: pattern.kind,
    pattern: pattern.pattern,
    distance: pattern.distance,
    caseInsensitive: pattern.case_insensitive,
    wholeWords: pattern.whole_words,
    lazy: pattern.lazy,
    prefilterAny: pattern.prefilter_any,
    prefilterCaseInsensitive: pattern.prefilter_case_insensitive,
    prefilterRegex: pattern.prefilter_regex,
  };
}

function toNapiOptions(options) {
  if (options === undefined) {
    return undefined;
  }
  return {
    literalCaseInsensitive: options.literal_case_insensitive,
    literalWholeWords: options.literal_whole_words,
    regexWholeWords: options.regex_whole_words,
    fuzzyCaseInsensitive: options.fuzzy_case_insensitive,
    fuzzyWholeWords: options.fuzzy_whole_words,
    fuzzyNormalizeDiacritics: options.fuzzy_normalize_diacritics,
  };
}

function toNapiRegexMeta(meta) {
  return {
    label: meta.label,
    score: meta.score,
    sourceDetail: meta.source_detail,
    requiresValidation: meta.requires_validation,
    minByteLength: meta.min_byte_length,
  };
}

function toNapiDenyListFilters(filters) {
  return {
    stopwords: filters.stopwords,
    allowList: filters.allow_list,
    personStopwords: filters.person_stopwords,
    addressStopwords: filters.address_stopwords,
    streetTypes: filters.street_types,
    firstNames: filters.first_names,
    genericRoles: filters.generic_roles,
    sentenceStarters: filters.sentence_starters,
    trailingAddressWordExclusions: filters.trailing_address_word_exclusions,
    definedTermCues: filters.defined_term_cues,
  };
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
