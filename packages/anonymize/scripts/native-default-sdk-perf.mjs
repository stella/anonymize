import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_DIR = resolve(join(import.meta.dir, ".."));
const ROOT_DIR = resolve(join(PACKAGE_DIR, "..", ".."));
const FIXTURES_DIR = join(
  PACKAGE_DIR,
  "src",
  "__test__",
  "fixtures",
  "contracts",
);
const WORKER = process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WORKER === "1";
const PRELOAD = process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_PRELOAD === "1";
const LANGUAGE = process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGE ?? "";
const ADAPTER =
  process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_ADAPTER ?? "ts-node";
const PYTHON_SDK_ROOT =
  process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_PYTHON_SDK_ROOT ?? "";
const WARM_ITERATIONS = positiveIntegerEnv(
  "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WARM_ITERATIONS",
  1,
);
const RESULT_MODE = resultModeFromEnv(
  process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_RESULT_MODE,
);
const REPEATS = repeatCountFromEnv(
  process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_REPEATS,
);
const OUTPUT_MODE = outputModeFromEnv(
  process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_OUTPUT,
);

if (WORKER) {
  await runWorker();
} else {
  runParent();
}

function runParent() {
  ensureDefaultNativePackages();
  const pythonSdk = preparePythonSdk();
  try {
    const scenarios = scenarioLanguages().map((language) => {
      const tsCold = runWorkerRepeated({
        adapter: "ts-node",
        language,
        preload: false,
      });
      const tsPreloaded = runWorkerRepeated({
        adapter: "ts-node",
        language,
        preload: true,
      });
      const pythonCold = runWorkerRepeated({
        adapter: "python",
        language,
        preload: false,
        pythonSdkRoot: pythonSdk.root,
      });
      const pythonPreloaded = runWorkerRepeated({
        adapter: "python",
        language,
        preload: true,
        pythonSdkRoot: pythonSdk.root,
      });
      const scenarioName = language === "" ? "default" : `default-${language}`;
      assertFixtureSignatureParity({
        scenarioName,
        mode: "cold",
        expected: tsCold,
        actual: pythonCold,
      });
      assertFixtureSignatureParity({
        scenarioName,
        mode: "preloaded",
        expected: tsPreloaded,
        actual: pythonPreloaded,
      });
      const adapters = [
        summarizeAdapterScenario("ts-node", tsCold, tsPreloaded),
        summarizeAdapterScenario("python", pythonCold, pythonPreloaded),
      ];
      return {
        name: scenarioName,
        language: language === "" ? null : language,
        packageBytes: tsCold.packageBytes,
        fixtureCount: tsCold.fixtureCount,
        sampleCount: tsCold.sampleCount,
        preloadedSampleCount: tsPreloaded.sampleCount,
        firstLoadMs: tsCold.loadMs,
        firstWarmupMs: tsCold.warmupMs,
        firstPrepareMs: tsCold.prepareMs,
        firstRunMs: tsCold.runMs,
        firstTouchMs: roundMs(tsCold.prepareMs + tsCold.runMs),
        warmClickMs: tsCold.warmAvgMs,
        preloadedLoadMs: tsPreloaded.loadMs,
        preloadedWarmupMs: tsPreloaded.warmupMs,
        setupBeforeClickMs: tsPreloaded.prepareMs,
        preloadedClickMs: tsPreloaded.runMs,
        preloadedWarmClickMs: tsPreloaded.warmAvgMs,
        prepareTopStages: tsCold.prepareTopStages,
        prepareTopSlots: tsCold.prepareTopSlots,
        warmupTopStages: tsCold.warmupTopStages,
        warmupTopSlots: tsCold.warmupTopSlots,
        preloadedPrepareTopStages: tsPreloaded.prepareTopStages,
        preloadedPrepareTopSlots: tsPreloaded.prepareTopSlots,
        preloadedWarmupTopStages: tsPreloaded.warmupTopStages,
        preloadedWarmupTopSlots: tsPreloaded.warmupTopSlots,
        runTopFixtures: tsCold.runTopFixtures,
        fixtureTimings: tsCold.fixtureTimings,
        preloadedFixtureTimings: tsPreloaded.fixtureTimings,
        adapters,
      };
    });

    const result = {
      event: "native-default-sdk-perf",
      resultMode: RESULT_MODE,
      repeats: REPEATS,
      scenarios,
    };

    console.log(
      JSON.stringify(
        OUTPUT_MODE === "summary" ? summarizePerfResult(result) : result,
      ),
    );
  } finally {
    pythonSdk.cleanup();
  }
}

async function runWorker() {
  const language = LANGUAGE.trim().toLowerCase();
  const pipelineOptions = language.length === 0 ? {} : { language };
  const fixtures = loadFixtures(language);
  const packageBytes = defaultPackageBytes(language);
  if (ADAPTER === "python") {
    runPythonWorker({ language, fixtures, packageBytes });
    return;
  }
  if (ADAPTER !== "ts-node") {
    throw new Error(`Invalid default SDK benchmark adapter: ${ADAPTER}`);
  }
  const nativeNode = await import("../src/native-node.ts");

  const loadStart = Bun.nanoseconds();
  const pipeline = nativeNode.getDefaultNativePipeline({
    ...pipelineOptions,
    warmup: nativeNode.DEFAULT_NATIVE_PIPELINE_WARMUPS.none,
  });
  const loadMs = elapsedMs(loadStart);
  const prepareDiagnosticsJson = pipeline.prepareDiagnosticsJson();
  const prepareTopStages = topDiagnosticStages(prepareDiagnosticsJson);
  const prepareTopSlots = topDiagnosticSlots(prepareDiagnosticsJson);
  const warmupStart = PRELOAD ? Bun.nanoseconds() : null;
  const warmupDiagnostics = PRELOAD
    ? pipeline.warmLazyRegexDiagnosticsJson()
    : null;
  const warmupMs = warmupStart === null ? 0 : elapsedMs(warmupStart);
  const warmupTopStages = topDiagnosticStages(warmupDiagnostics);
  const warmupTopSlots = topDiagnosticSlots(warmupDiagnostics);
  const prepareMs = roundMs(loadMs + warmupMs);

  const coldRun = runFixtures(pipeline, fixtures);
  const runProfile = profileSlowestFixture(pipeline, coldRun, fixtures);
  const warmRuns = [];
  for (let index = 0; index < WARM_ITERATIONS; index += 1) {
    warmRuns.push(runFixtures(pipeline, fixtures));
  }
  const warmAvgMs =
    WARM_ITERATIONS === 0 ? 0 : roundMs(totalRunMs(warmRuns) / WARM_ITERATIONS);

  console.log(
    JSON.stringify({
      event: "native-default-sdk-perf-worker",
      language: language.length === 0 ? null : language,
      preload: PRELOAD,
      packageBytes,
      fixtureCount: fixtures.length,
      loadMs,
      warmupMs,
      prepareMs,
      runMs: coldRun.ms,
      warmAvgMs,
      prepareTopStages,
      prepareTopSlots,
      warmupTopStages,
      warmupTopSlots,
      runProfile,
      fixtureTimings: summarizeFixtureTimings(coldRun, warmRuns),
      runTopFixtures: coldRun.fixtures
        .toSorted((left, right) => right.ms - left.ms)
        .slice(0, 5)
        .map(publicFixtureTiming),
      fixtureSignatures: coldRun.fixtures.map(({ fixture, signature }) => ({
        fixture,
        signature,
      })),
    }),
  );
}

function runWorkerRepeated(options) {
  const samples = [];
  for (let index = 0; index < REPEATS; index += 1) {
    samples.push(runWorkerProcess(options));
  }
  return aggregateWorkerSamples(samples);
}

function runWorkerProcess({ adapter, language, preload, pythonSdkRoot }) {
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WORKER: "1",
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_PRELOAD: preload ? "1" : "0",
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGE: language,
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_ADAPTER: adapter,
      ...(pythonSdkRoot === undefined
        ? {}
        : { ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_PYTHON_SDK_ROOT: pythonSdkRoot }),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (child.status !== 0) {
    throw new Error(
      [
        "Native default SDK benchmark worker failed",
        child.stdout.trim(),
        child.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  for (const line of child.stdout.trim().split("\n").toReversed()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "native-default-sdk-perf-worker") {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error("Native default SDK benchmark worker did not emit JSON");
}

function aggregateWorkerSamples(samples) {
  const first = samples[0];
  if (first === undefined) {
    throw new Error("Native default SDK benchmark did not collect samples");
  }
  assertWorkerSamplesCompatible(samples);
  const byFixture = aggregateFixtureTimings(samples);
  const representativePrepare = representativeSample(samples, "prepareMs");
  const representativeRun = representativeSample(samples, "runMs");
  const representativeWarmup = representativeSample(samples, "warmupMs");
  return {
    ...first,
    sampleCount: samples.length,
    samples: samples.map(compactWorkerSample),
    loadMs: medianMs(samples.map((sample) => sample.loadMs)),
    warmupMs: medianMs(samples.map((sample) => sample.warmupMs)),
    prepareMs: medianMs(samples.map((sample) => sample.prepareMs)),
    runMs: medianMs(samples.map((sample) => sample.runMs)),
    warmAvgMs: medianMs(samples.map((sample) => sample.warmAvgMs)),
    prepareTopStages: representativePrepare.prepareTopStages,
    prepareTopSlots: representativePrepare.prepareTopSlots,
    warmupTopStages: representativeWarmup.warmupTopStages,
    warmupTopSlots: representativeWarmup.warmupTopSlots,
    fixtureTimings: {
      cold: summarizeMs(byFixture.map((fixture) => fixture.coldMs)),
      warm: summarizeMs(byFixture.map((fixture) => fixture.warmAvgMs)),
      byFixture,
    },
    runTopFixtures: byFixture
      .toSorted((left, right) => right.coldMs - left.coldMs)
      .slice(0, 5)
      .map(({ coldMs, fixture, entityCount, redactedTextLength }) => ({
        fixture,
        ms: coldMs,
        entityCount,
        redactedTextLength,
      })),
    fixtureSignatures: representativeRun.fixtureSignatures,
  };
}

function assertWorkerSamplesCompatible(samples) {
  const first = samples[0];
  if (first === undefined) {
    return;
  }
  for (const sample of samples.slice(1)) {
    if (
      sample.language !== first.language ||
      sample.preload !== first.preload ||
      sample.packageBytes !== first.packageBytes ||
      sample.fixtureCount !== first.fixtureCount
    ) {
      throw new Error("Native default SDK benchmark samples are incompatible");
    }
    assertFixtureSignatureParity({
      scenarioName: first.language ?? "default",
      mode: first.preload ? "preloaded-repeat" : "cold-repeat",
      expected: first,
      actual: sample,
    });
  }
}

function aggregateFixtureTimings(samples) {
  const first = samples[0];
  if (first === undefined) {
    return [];
  }
  return first.fixtureTimings.byFixture.map((fixture) => {
    const entries = samples.map((sample) => {
      const match = sample.fixtureTimings.byFixture.find(
        (candidate) => candidate.fixture === fixture.fixture,
      );
      if (match === undefined) {
        throw new Error(`Missing fixture timing for ${fixture.fixture}`);
      }
      if (
        match.entityCount !== fixture.entityCount ||
        match.redactedTextLength !== fixture.redactedTextLength
      ) {
        throw new Error(
          `Fixture output changed across repeats: ${fixture.fixture}`,
        );
      }
      return match;
    });
    return {
      fixture: fixture.fixture,
      coldMs: medianMs(entries.map((entry) => entry.coldMs)),
      warmAvgMs: medianMs(entries.map((entry) => entry.warmAvgMs)),
      entityCount: fixture.entityCount,
      redactedTextLength: fixture.redactedTextLength,
    };
  });
}

function representativeSample(samples, metric) {
  const median = medianNumber(samples.map((sample) => sample[metric]));
  const sample = samples
    .toSorted(
      (left, right) =>
        Math.abs(left[metric] - median) - Math.abs(right[metric] - median),
    )
    .at(0);
  if (sample === undefined) {
    throw new Error("Native default SDK benchmark did not collect samples");
  }
  return sample;
}

function compactWorkerSample(sample) {
  return {
    loadMs: sample.loadMs,
    warmupMs: sample.warmupMs,
    prepareMs: sample.prepareMs,
    runMs: sample.runMs,
    warmAvgMs: sample.warmAvgMs,
    fixtureTimings: {
      cold: sample.fixtureTimings.cold,
      warm: sample.fixtureTimings.warm,
    },
  };
}

function runPythonWorker({ language, fixtures, packageBytes }) {
  if (PYTHON_SDK_ROOT.length === 0) {
    throw new Error("Python SDK root is required for the Python perf worker");
  }
  const payload = {
    language: language.length === 0 ? null : language,
    preload: PRELOAD,
    package_bytes: packageBytes,
    result_mode: RESULT_MODE,
    warm_iterations: WARM_ITERATIONS,
    fixtures,
  };
  const child = spawnSync("python3", ["-c", pythonWorkerScript()], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      STELLA_ANONYMIZE_DEFAULT_SDK_PERF_PAYLOAD: JSON.stringify(payload),
      STELLA_ANONYMIZE_PYTHON_SDK_ROOT: PYTHON_SDK_ROOT,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      [
        "Python default SDK benchmark worker failed",
        child.stdout.trim(),
        child.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  process.stdout.write(child.stdout);
}

function runFixtures(pipeline, fixtures) {
  const started = Bun.nanoseconds();
  const results = [];
  for (const fixture of fixtures) {
    const fixtureStart = Bun.nanoseconds();
    const result = runFixture(pipeline, fixture.text);
    results.push({
      fixture: fixture.fixture,
      ms: elapsedMs(fixtureStart),
      entityCount: result.entityCount,
      redactedTextLength: result.redactedTextLength,
      signature: hashSignature(result.canonical),
    });
  }
  return {
    ms: elapsedMs(started),
    fixtures: results,
  };
}

function runFixture(pipeline, text) {
  if (RESULT_MODE === "json") {
    const canonical = canonicalJsonResult(
      JSON.parse(pipeline.redactTextJson(text)),
    );
    return {
      canonical,
      entityCount: canonical.redaction.entity_count,
      redactedTextLength: canonical.redaction.redacted_text.length,
    };
  }
  const result = pipeline.redactText(text);
  const canonical = canonicalNativeResult(result);
  return {
    canonical,
    entityCount: result.redaction.entityCount,
    redactedTextLength: result.redaction.redactedText.length,
  };
}

function profileSlowestFixture(pipeline, coldRun, fixtures) {
  const slowest = coldRun.fixtures
    .toSorted((left, right) => right.ms - left.ms)
    .at(0);
  if (slowest === undefined) {
    return null;
  }
  const fixture = fixtures.find(
    (candidate) => candidate.fixture === slowest.fixture,
  );
  if (fixture === undefined) {
    return null;
  }
  const diagnosticsJson = pipeline.summary_diagnostics_json(fixture.text);
  return {
    fixture: slowest.fixture,
    coldMs: slowest.ms,
    topStages: topRuntimeDiagnosticStages(diagnosticsJson),
    topSlots: topRuntimeDiagnosticSlots(diagnosticsJson),
  };
}

function publicFixtureTiming({ fixture, ms, entityCount, redactedTextLength }) {
  return { fixture, ms, entityCount, redactedTextLength };
}

function summarizeFixtureTimings(coldRun, warmRuns) {
  return {
    cold: summarizeMs(coldRun.fixtures.map((fixture) => fixture.ms)),
    warm:
      warmRuns.length === 0
        ? summarizeMs([])
        : summarizeMs(
            warmRuns.flatMap((run) =>
              run.fixtures.map((fixture) => fixture.ms),
            ),
          ),
    byFixture: coldRun.fixtures.map((fixture) => ({
      fixture: fixture.fixture,
      coldMs: fixture.ms,
      warmAvgMs:
        warmRuns.length === 0
          ? 0
          : roundMs(warmFixtureMs(warmRuns, fixture.fixture) / warmRuns.length),
      entityCount: fixture.entityCount,
      redactedTextLength: fixture.redactedTextLength,
    })),
  };
}

function canonicalNativeResult(result) {
  return {
    resolved_entities: result.resolvedEntities.map((entity) => ({
      start: entity.start,
      end: entity.end,
      label: entity.label,
      text: entity.text,
      score: entity.score.toFixed(6),
      source: entity.source,
      source_detail: entity.sourceDetail ?? null,
    })),
    redaction: {
      redacted_text: result.redaction.redactedText,
      redaction_map: [...result.redaction.redactionMap.entries()].map(
        ([placeholder, original]) => ({ placeholder, original }),
      ),
      operator_map: [...result.redaction.operatorMap.entries()].map(
        ([placeholder, operator]) => ({ placeholder, operator }),
      ),
      entity_count: result.redaction.entityCount,
    },
  };
}

function canonicalJsonResult(result) {
  return {
    resolved_entities: result.resolved_entities.map((entity) => ({
      start: entity.start,
      end: entity.end,
      label: entity.label,
      text: entity.text,
      score: entity.score.toFixed(6),
      source: entity.source,
      source_detail: entity.source_detail ?? null,
    })),
    redaction: {
      redacted_text: result.redaction.redacted_text,
      redaction_map: result.redaction.redaction_map,
      operator_map: result.redaction.operator_map,
      entity_count: result.redaction.entity_count,
    },
  };
}

function hashSignature(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function summarizeAdapterScenario(adapter, cold, preloaded) {
  return {
    adapter,
    packageBytes: cold.packageBytes,
    fixtureCount: cold.fixtureCount,
    firstLoadMs: cold.loadMs,
    firstWarmupMs: cold.warmupMs,
    firstPrepareMs: cold.prepareMs,
    firstRunMs: cold.runMs,
    firstTouchMs: roundMs(cold.prepareMs + cold.runMs),
    warmClickMs: cold.warmAvgMs,
    preloadedLoadMs: preloaded.loadMs,
    preloadedWarmupMs: preloaded.warmupMs,
    setupBeforeClickMs: preloaded.prepareMs,
    preloadedClickMs: preloaded.runMs,
    preloadedWarmClickMs: preloaded.warmAvgMs,
    sampleCount: cold.sampleCount,
    preloadedSampleCount: preloaded.sampleCount,
    samples: cold.samples,
    preloadedSamples: preloaded.samples,
    prepareTopStages: cold.prepareTopStages,
    prepareTopSlots: cold.prepareTopSlots,
    warmupTopStages: cold.warmupTopStages,
    warmupTopSlots: cold.warmupTopSlots,
    preloadedPrepareTopStages: preloaded.prepareTopStages,
    preloadedPrepareTopSlots: preloaded.prepareTopSlots,
    preloadedWarmupTopStages: preloaded.warmupTopStages,
    preloadedWarmupTopSlots: preloaded.warmupTopSlots,
    runProfile: cold.runProfile,
    preloadedRunProfile: preloaded.runProfile,
    runTopFixtures: cold.runTopFixtures,
    fixtureTimings: cold.fixtureTimings,
    preloadedFixtureTimings: preloaded.fixtureTimings,
  };
}

function summarizePerfResult(result) {
  return {
    event: "native-default-sdk-perf-summary",
    resultMode: result.resultMode,
    repeats: result.repeats,
    scenarios: result.scenarios.map(summarizePerfScenario),
  };
}

function summarizePerfScenario(scenario) {
  return {
    name: scenario.name,
    language: scenario.language,
    packageBytes: scenario.packageBytes,
    packageMb: roundMs(scenario.packageBytes / (1024 * 1024)),
    fixtureCount: scenario.fixtureCount,
    adapters: scenario.adapters.map(summarizePerfAdapter),
  };
}

function summarizePerfAdapter(adapter) {
  return {
    adapter: adapter.adapter,
    firstTouchMs: adapter.firstTouchMs,
    firstPrepareMs: adapter.firstPrepareMs,
    firstRunMs: adapter.firstRunMs,
    warmClickMs: adapter.warmClickMs,
    setupBeforeClickMs: adapter.setupBeforeClickMs,
    preloadedClickMs: adapter.preloadedClickMs,
    preloadedWarmClickMs: adapter.preloadedWarmClickMs,
    fixtureTimings: adapter.fixtureTimings,
    preloadedFixtureTimings: adapter.preloadedFixtureTimings,
    prepareTopStages: adapter.prepareTopStages.slice(0, 6),
    prepareTopSlots: adapter.prepareTopSlots.slice(0, 8),
    preloadedPrepareTopStages: adapter.preloadedPrepareTopStages.slice(0, 6),
    preloadedPrepareTopSlots: adapter.preloadedPrepareTopSlots.slice(0, 8),
    preloadedWarmupTopStages: adapter.preloadedWarmupTopStages.slice(0, 6),
    preloadedWarmupTopSlots: adapter.preloadedWarmupTopSlots.slice(0, 8),
    runProfile: adapter.runProfile,
    preloadedRunProfile: adapter.preloadedRunProfile,
    runTopFixtures: adapter.runTopFixtures.slice(0, 5),
  };
}

function assertFixtureSignatureParity({
  scenarioName,
  mode,
  expected,
  actual,
}) {
  const actualByFixture = new Map(
    actual.fixtureSignatures.map(({ fixture, signature }) => [
      fixture,
      signature,
    ]),
  );
  for (const { fixture, signature } of expected.fixtureSignatures) {
    const actualSignature = actualByFixture.get(fixture);
    if (actualSignature === signature) {
      continue;
    }
    throw new Error(
      [
        `Default SDK parity mismatch in ${scenarioName}/${mode}`,
        `fixture=${fixture}`,
        `expected=${signature}`,
        `actual=${actualSignature ?? "<missing>"}`,
      ].join(" "),
    );
  }
}

function totalRunMs(runs) {
  let total = 0;
  for (const run of runs) {
    total += run.ms;
  }
  return total;
}

function warmFixtureMs(warmRuns, fixtureName) {
  let total = 0;
  for (const run of warmRuns) {
    const match = run.fixtures.find(
      (candidate) => candidate.fixture === fixtureName,
    );
    total += match?.ms ?? 0;
  }
  return total;
}

function summarizeMs(values) {
  if (values.length === 0) {
    return { minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = values.toSorted((left, right) => left - right);
  return {
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
  };
}

function medianMs(values) {
  return roundMs(medianNumber(values));
}

function medianNumber(values) {
  const sorted = values.toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  const right = sorted.at(middle) ?? 0;
  if (sorted.length % 2 === 1) {
    return right;
  }
  const left = sorted.at(middle - 1) ?? right;
  return (left + right) / 2;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor((sortedValues.length - 1) * percentileValue),
  );
  return sortedValues[index];
}

function topDiagnosticStages(diagnosticsJson) {
  return diagnosticStageSummaries(diagnosticsJson).slice(0, 10);
}

function topRuntimeDiagnosticStages(diagnosticsJson) {
  return diagnosticStageSummaries(diagnosticsJson)
    .filter(isRuntimeDiagnosticSummary)
    .slice(0, 10);
}

function diagnosticStageSummaries(diagnosticsJson) {
  return diagnosticEvents(diagnosticsJson)
    .filter((event) => typeof event.stage === "string")
    .map((event) => ({
      phase:
        typeof event.phase === "string"
          ? event.phase
          : diagnosticPhaseFromStage(event.stage),
      scope:
        typeof event.scope === "string"
          ? event.scope
          : diagnosticScopeFromStageSummary({
              stage: event.stage,
              slot: event.slot,
            }),
      stage: event.stage,
      elapsedMs:
        typeof event.elapsed_us === "number"
          ? roundMs(event.elapsed_us / 1_000)
          : null,
      count: typeof event.count === "number" ? event.count : null,
      inputBytes:
        typeof event.input_bytes === "number" ? event.input_bytes : null,
      patternCount:
        typeof event.pattern_count === "number" ? event.pattern_count : null,
      artifactCount:
        typeof event.artifact_count === "number" ? event.artifact_count : null,
      artifactBytes:
        typeof event.artifact_bytes === "number" ? event.artifact_bytes : null,
    }))
    .filter((event) => event.elapsedMs !== null)
    .toSorted((left, right) => (right.elapsedMs ?? 0) - (left.elapsedMs ?? 0));
}

function topDiagnosticSlots(diagnosticsJson) {
  return diagnosticSlotSummaries(diagnosticsJson).slice(0, 20);
}

function topRuntimeDiagnosticSlots(diagnosticsJson) {
  return diagnosticSlotSummaries(diagnosticsJson)
    .filter(isRuntimeDiagnosticSummary)
    .slice(0, 20);
}

function diagnosticSlotSummaries(diagnosticsJson) {
  return diagnosticEvents(diagnosticsJson)
    .filter(
      (event) =>
        typeof event.stage === "string" &&
        typeof event.slot === "number" &&
        typeof event.elapsed_us === "number",
    )
    .map((event) => ({
      phase:
        typeof event.phase === "string"
          ? event.phase
          : diagnosticPhaseFromStage(event.stage),
      stage: event.stage,
      slot: event.slot,
      subslot: typeof event.subslot === "number" ? event.subslot : null,
      engine: typeof event.engine === "string" ? event.engine : null,
      pattern: typeof event.pattern === "number" ? event.pattern : null,
      patternCount:
        typeof event.pattern_count === "number" ? event.pattern_count : null,
      elapsedMs: roundMs(event.elapsed_us / 1_000),
      count: typeof event.count === "number" ? event.count : null,
      inputBytes:
        typeof event.input_bytes === "number" ? event.input_bytes : null,
      artifactCount:
        typeof event.artifact_count === "number" ? event.artifact_count : null,
      artifactBytes:
        typeof event.artifact_bytes === "number" ? event.artifact_bytes : null,
    }))
    .toSorted((left, right) => right.elapsedMs - left.elapsedMs);
}

function isRuntimeDiagnosticSummary(event) {
  return event.phase !== "prepare" && event.phase !== "warm";
}

function diagnosticEvents(diagnosticsJson) {
  if (diagnosticsJson === null) {
    return [];
  }
  const parsed = JSON.parse(diagnosticsJson);
  const events = parsed.events ?? parsed.diagnostics?.events;
  return Array.isArray(events) ? events : [];
}

function diagnosticScopeFromStageSummary({ stage, slot }) {
  if (typeof slot === "number") {
    return "slot";
  }
  if (
    stage === "detect.total" ||
    stage === "find-matches" ||
    stage === "redact.total" ||
    stage === "prepare.total" ||
    stage === "warm.total"
  ) {
    return "total";
  }
  return "step";
}

function diagnosticPhaseFromStage(stage) {
  if (stage.startsWith("prepare.")) {
    return "prepare";
  }
  if (stage.startsWith("warm.")) {
    return "warm";
  }
  if (
    stage === "normalize" ||
    stage === "find-matches" ||
    stage.startsWith("find.") ||
    stage.startsWith("search.")
  ) {
    return "search";
  }
  if (
    stage === "detect.total" ||
    stage === "entity.regex" ||
    stage === "entity.custom-regex" ||
    stage === "entity.anchored" ||
    stage === "entity.deny-list" ||
    stage === "entity.gazetteer" ||
    stage === "entity.country" ||
    stage === "entity.trigger" ||
    stage === "entity.signature" ||
    stage === "entity.legal-form" ||
    stage === "entity.address-seed" ||
    stage === "entity.name-corpus"
  ) {
    return "detect";
  }
  if (stage === "redact.total" || stage === "redaction") {
    return "redact";
  }
  return "resolve";
}

function preparePythonSdk() {
  ensurePythonNativeLibrary();
  const tempRoot = mkdtempSync(join(tmpdir(), "stella-anonymize-default-sdk-"));
  const packageRoot = join(tempRoot, "stella_anonymize");
  cpSync(
    join(ROOT_DIR, "crates", "anonymize-py", "python", "stella_anonymize"),
    packageRoot,
    { recursive: true },
  );
  mkdirSync(packageRoot, { recursive: true });
  copyFileSync(
    nativeLibraryPath("stella_anonymize_core_py"),
    join(packageRoot, "_native.so"),
  );
  return {
    root: tempRoot,
    cleanup: () => rmSync(tempRoot, { force: true, recursive: true }),
  };
}

function ensureDefaultNativePackages() {
  const languages = scenarioLanguages();
  const packagePaths = languages.map(defaultPackagePath);
  const newestInput = newestMtimeMs(defaultNativePackageInputs());
  const packagesFresh = packagePaths.every(
    (path) => existsSync(path) && statSync(path).mtimeMs >= newestInput,
  );
  if (packagesFresh) {
    return;
  }

  const scopedLanguages = languages.filter((language) => language.length > 0);
  const build = spawnSync("bun", ["run", "build"], {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES: scopedLanguages.join(","),
    },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (build.status === 0) {
    return;
  }
  throw new Error(
    [
      "Failed to build default native packages",
      build.stdout.trim(),
      build.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function defaultNativePackageInputs() {
  return [
    join(ROOT_DIR, "Cargo.lock"),
    join(ROOT_DIR, "Cargo.toml"),
    join(ROOT_DIR, "crates", "anonymize-adapter-contract", "Cargo.toml"),
    join(ROOT_DIR, "crates", "anonymize-adapter-contract", "src"),
    join(ROOT_DIR, "crates", "anonymize-core", "Cargo.toml"),
    join(ROOT_DIR, "crates", "anonymize-core", "src"),
    join(ROOT_DIR, "crates", "anonymize-napi", "Cargo.toml"),
    join(ROOT_DIR, "crates", "anonymize-napi", "src"),
    join(PACKAGE_DIR, "package.json"),
    join(PACKAGE_DIR, "scripts", "build-native-node.mjs"),
    join(PACKAGE_DIR, "scripts", "build-native-pipeline-package.mjs"),
    join(PACKAGE_DIR, "src"),
  ];
}

function ensurePythonNativeLibrary() {
  const libraryPath = nativeLibraryPath("stella_anonymize_core_py");
  if (existsSync(libraryPath) && !pythonNativeLibraryIsStale(libraryPath)) {
    return;
  }
  const build = spawnSync(
    "cargo",
    ["build", "-p", "stella-anonymize-py", "--release", "--locked"],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (build.status === 0) {
    return;
  }
  throw new Error(
    [
      "Failed to build Python native library",
      build.stdout.trim(),
      build.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function pythonNativeLibraryIsStale(libraryPath) {
  const libraryMtimeMs = statSync(libraryPath).mtimeMs;
  return (
    newestMtimeMs([
      join(ROOT_DIR, "Cargo.lock"),
      join(ROOT_DIR, "crates", "anonymize-adapter-contract", "Cargo.toml"),
      join(ROOT_DIR, "crates", "anonymize-adapter-contract", "src"),
      join(ROOT_DIR, "crates", "anonymize-core", "Cargo.toml"),
      join(ROOT_DIR, "crates", "anonymize-core", "src"),
      join(ROOT_DIR, "crates", "anonymize-py", "Cargo.toml"),
      join(ROOT_DIR, "crates", "anonymize-py", "src"),
    ]) > libraryMtimeMs
  );
}

function newestMtimeMs(paths) {
  let newest = 0;
  for (const path of paths) {
    const stats = statSync(path);
    newest = Math.max(newest, stats.mtimeMs);
    if (!stats.isDirectory()) {
      continue;
    }
    newest = Math.max(
      newest,
      newestMtimeMs(readdirSync(path).map((entry) => join(path, entry))),
    );
  }
  return newest;
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

function loadFixtures(language) {
  const languages =
    language.length === 0 ? ["cs", "de", "en"] : [normalizeLanguage(language)];
  const fixtures = [];
  for (const currentLanguage of languages) {
    const languageDir = join(FIXTURES_DIR, currentLanguage);
    for (const entry of readdirSorted(languageDir)) {
      if (!entry.endsWith(".txt")) {
        continue;
      }
      const path = join(languageDir, entry);
      fixtures.push({
        fixture: relative(FIXTURES_DIR, path),
        text: readFileSync(path, "utf8"),
      });
    }
  }
  return fixtures;
}

function readdirSorted(path) {
  return readdirSync(path).sort((left, right) => left.localeCompare(right));
}

function defaultPackageBytes(language) {
  const packagePath = defaultPackagePath(language);
  if (!existsSync(packagePath)) {
    throw new Error(
      `Default native pipeline package is missing: ${packagePath}`,
    );
  }
  return statSync(packagePath).size;
}

function defaultPackagePath(language) {
  return language.length === 0
    ? join(PACKAGE_DIR, "native-pipeline.stlanonpkg")
    : join(
        PACKAGE_DIR,
        `native-pipeline.${normalizeLanguage(language)}.stlanonpkg`,
      );
}

function scenarioLanguages() {
  const value =
    process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGES ?? "all,cs,de,en";
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry === "all" || entry === "default" ? "" : entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function resultModeFromEnv(value) {
  const normalized = (value ?? "structured").trim().toLowerCase();
  switch (normalized) {
    case "json":
    case "structured":
      return normalized;
    default:
      throw new Error(
        "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_RESULT_MODE must be json or structured",
      );
  }
}

function outputModeFromEnv(value) {
  const normalized = (value ?? "full").trim().toLowerCase();
  switch (normalized) {
    case "full":
    case "summary":
      return normalized;
    default:
      throw new Error(
        "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_OUTPUT must be full or summary",
      );
  }
}

function repeatCountFromEnv(value) {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) {
    return 1;
  }
  const count = Number(raw);
  if (count < 1) {
    throw new Error(
      "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_REPEATS must be at least 1",
    );
  }
  if (!Number.isInteger(count)) {
    throw new Error(
      "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_REPEATS must be an integer",
    );
  }
  return count;
}

function normalizeLanguage(language) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(language)) {
    throw new Error(`Invalid default SDK benchmark language: ${language}`);
  }
  return language;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function elapsedMs(start) {
  return roundMs((Bun.nanoseconds() - start) / 1_000_000);
}

function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

function pythonWorkerScript() {
  return String.raw`
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.environ["STELLA_ANONYMIZE_PYTHON_SDK_ROOT"])

import stella_anonymize as anonymize

def run_fixtures(pipeline, fixtures, result_mode):
    started = time.perf_counter_ns()
    results = []
    for fixture in fixtures:
        fixture_start = time.perf_counter_ns()
        result = run_fixture(pipeline, fixture["text"], result_mode)
        results.append(
            {
                "fixture": fixture["fixture"],
                "ms": elapsed_ms(fixture_start),
                "entityCount": result["entityCount"],
                "redactedTextLength": result["redactedTextLength"],
                "signature": hash_signature(result["canonical"]),
            }
        )
    return {"ms": elapsed_ms(started), "fixtures": results}

def run_fixture(pipeline, text, result_mode):
    if result_mode == "json":
        canonical = canonical_json_result(json.loads(pipeline.redact_text_json(text)))
        return {
            "canonical": canonical,
            "entityCount": canonical["redaction"]["entity_count"],
            "redactedTextLength": len(canonical["redaction"]["redacted_text"]),
        }
    result = pipeline.redact_text(text)
    return {
        "canonical": canonical_result(result),
        "entityCount": result.redaction.entity_count,
        "redactedTextLength": len(result.redaction.redacted_text),
    }

def profile_slowest_fixture(pipeline, cold_run, fixtures):
    if len(cold_run["fixtures"]) == 0:
        return None
    slowest = sorted(
        cold_run["fixtures"],
        key=lambda fixture: fixture["ms"],
        reverse=True,
    )[0]
    fixture = next(
        (
            candidate
            for candidate in fixtures
            if candidate["fixture"] == slowest["fixture"]
        ),
        None,
    )
    if fixture is None:
        return None
    diagnostics_json = pipeline.summary_diagnostics_json(fixture["text"])
    return {
        "fixture": slowest["fixture"],
        "coldMs": slowest["ms"],
        "topStages": top_runtime_diagnostic_stages(diagnostics_json),
        "topSlots": top_runtime_diagnostic_slots(diagnostics_json),
    }

def public_fixture_timing(fixture):
    return {
        "fixture": fixture["fixture"],
        "ms": fixture["ms"],
        "entityCount": fixture["entityCount"],
        "redactedTextLength": fixture["redactedTextLength"],
    }

def summarize_fixture_timings(cold_run, warm_runs):
    return {
        "cold": summarize_ms([fixture["ms"] for fixture in cold_run["fixtures"]]),
        "warm": summarize_ms(
            [
                fixture["ms"]
                for run in warm_runs
                for fixture in run["fixtures"]
            ]
        ),
        "byFixture": [
            {
                "fixture": fixture["fixture"],
                "coldMs": fixture["ms"],
                "warmAvgMs": round_ms(
                    warm_fixture_ms(warm_runs, fixture["fixture"])
                    / len(warm_runs)
                )
                if len(warm_runs) > 0
                else 0,
                "entityCount": fixture["entityCount"],
                "redactedTextLength": fixture["redactedTextLength"],
            }
            for fixture in cold_run["fixtures"]
        ],
    }

def warm_fixture_ms(warm_runs, fixture_name):
    total = 0
    for run in warm_runs:
        for fixture in run["fixtures"]:
            if fixture["fixture"] == fixture_name:
                total += fixture["ms"]
                break
    return total

def summarize_ms(values):
    if len(values) == 0:
        return {"minMs": 0, "p50Ms": 0, "p95Ms": 0, "maxMs": 0}
    sorted_values = sorted(values)
    return {
        "minMs": sorted_values[0],
        "p50Ms": percentile(sorted_values, 0.5),
        "p95Ms": percentile(sorted_values, 0.95),
        "maxMs": sorted_values[-1],
    }

def percentile(sorted_values, percentile_value):
    if len(sorted_values) == 0:
        return 0
    index = min(
        len(sorted_values) - 1,
        int((len(sorted_values) - 1) * percentile_value),
    )
    return sorted_values[index]

def canonical_result(result):
    return {
        "resolved_entities": [
            {
                "start": entity.start,
                "end": entity.end,
                "label": entity.label,
                "text": entity.text,
                "score": format(float(entity.score), ".6f"),
                "source": entity.source,
                "source_detail": entity.source_detail,
            }
            for entity in result.resolved_entities
        ],
        "redaction": {
            "redacted_text": result.redaction.redacted_text,
            "redaction_map": [
                {
                    "placeholder": entry.placeholder,
                    "original": entry.original,
                }
                for entry in result.redaction.redaction_map
            ],
            "operator_map": [
                {
                    "placeholder": entry.placeholder,
                    "operator": entry.operator,
                }
                for entry in result.redaction.operator_map
            ],
            "entity_count": result.redaction.entity_count,
        },
    }

def canonical_json_result(result):
    return {
        "resolved_entities": [
            {
                "start": entity["start"],
                "end": entity["end"],
                "label": entity["label"],
                "text": entity["text"],
                "score": format(float(entity["score"]), ".6f"),
                "source": entity["source"],
                "source_detail": entity.get("source_detail"),
            }
            for entity in result["resolved_entities"]
        ],
        "redaction": {
            "redacted_text": result["redaction"]["redacted_text"],
            "redaction_map": result["redaction"]["redaction_map"],
            "operator_map": result["redaction"]["operator_map"],
            "entity_count": result["redaction"]["entity_count"],
        },
    }

def hash_signature(value):
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:16]

def diagnostic_events(diagnostics_json):
    if diagnostics_json is None:
        return []
    parsed = json.loads(diagnostics_json)
    events = parsed.get("events") or parsed.get("diagnostics", {}).get("events")
    return events if isinstance(events, list) else []

def top_diagnostic_stages(diagnostics_json):
    return diagnostic_stage_summaries(diagnostics_json)[:10]

def top_runtime_diagnostic_stages(diagnostics_json):
    return [
        event
        for event in diagnostic_stage_summaries(diagnostics_json)
        if is_runtime_diagnostic_summary(event)
    ][:10]

def diagnostic_stage_summaries(diagnostics_json):
    events = diagnostic_events(diagnostics_json)
    stages = []
    for event in events:
        stage = event.get("stage")
        elapsed_us = event.get("elapsed_us")
        if not isinstance(stage, str) or not isinstance(elapsed_us, (int, float)):
            continue
        stages.append(
            {
                "phase": event.get("phase") if isinstance(event.get("phase"), str) else diagnostic_phase_from_stage(stage),
                "scope": event.get("scope") if isinstance(event.get("scope"), str) else diagnostic_scope_from_stage_summary(stage, event.get("slot")),
                "stage": stage,
                "elapsedMs": round_ms(elapsed_us / 1_000),
                "count": event.get("count") if isinstance(event.get("count"), int) else None,
                "inputBytes": event.get("input_bytes") if isinstance(event.get("input_bytes"), int) else None,
                "patternCount": event.get("pattern_count") if isinstance(event.get("pattern_count"), int) else None,
                "artifactCount": event.get("artifact_count") if isinstance(event.get("artifact_count"), int) else None,
                "artifactBytes": event.get("artifact_bytes") if isinstance(event.get("artifact_bytes"), int) else None,
            }
        )
    return sorted(stages, key=lambda event: event["elapsedMs"], reverse=True)

def top_diagnostic_slots(diagnostics_json):
    return diagnostic_slot_summaries(diagnostics_json)[:20]

def top_runtime_diagnostic_slots(diagnostics_json):
    return [
        event
        for event in diagnostic_slot_summaries(diagnostics_json)
        if is_runtime_diagnostic_summary(event)
    ][:20]

def diagnostic_slot_summaries(diagnostics_json):
    slots = []
    for event in diagnostic_events(diagnostics_json):
        stage = event.get("stage")
        slot = event.get("slot")
        elapsed_us = event.get("elapsed_us")
        if (
            not isinstance(stage, str)
            or not isinstance(slot, int)
            or not isinstance(elapsed_us, (int, float))
        ):
            continue
        slots.append(
            {
                "phase": event.get("phase") if isinstance(event.get("phase"), str) else diagnostic_phase_from_stage(stage),
                "stage": stage,
                "slot": slot,
                "subslot": event.get("subslot") if isinstance(event.get("subslot"), int) else None,
                "engine": event.get("engine") if isinstance(event.get("engine"), str) else None,
                "pattern": event.get("pattern") if isinstance(event.get("pattern"), int) else None,
                "patternCount": event.get("pattern_count") if isinstance(event.get("pattern_count"), int) else None,
                "elapsedMs": round_ms(elapsed_us / 1_000),
                "count": event.get("count") if isinstance(event.get("count"), int) else None,
                "inputBytes": event.get("input_bytes") if isinstance(event.get("input_bytes"), int) else None,
                "artifactCount": event.get("artifact_count") if isinstance(event.get("artifact_count"), int) else None,
                "artifactBytes": event.get("artifact_bytes") if isinstance(event.get("artifact_bytes"), int) else None,
            }
        )
    return sorted(slots, key=lambda event: event["elapsedMs"], reverse=True)

def is_runtime_diagnostic_summary(event):
    return event["phase"] != "prepare" and event["phase"] != "warm"

def diagnostic_scope_from_stage_summary(stage, slot):
    if isinstance(slot, int):
        return "slot"
    if stage in {
        "detect.total",
        "find-matches",
        "redact.total",
        "prepare.total",
        "warm.total",
    }:
        return "total"
    return "step"

def diagnostic_phase_from_stage(stage):
    if stage.startswith("prepare."):
        return "prepare"
    if stage.startswith("warm."):
        return "warm"
    if (
        stage == "normalize"
        or stage == "find-matches"
        or stage.startswith("find.")
        or stage.startswith("search.")
    ):
        return "search"
    if stage in {
        "detect.total",
        "entity.regex",
        "entity.custom-regex",
        "entity.anchored",
        "entity.deny-list",
        "entity.gazetteer",
        "entity.country",
        "entity.trigger",
        "entity.signature",
        "entity.legal-form",
        "entity.address-seed",
        "entity.name-corpus",
    }:
        return "detect"
    if stage == "redact.total" or stage == "redaction":
        return "redact"
    return "resolve"

def elapsed_ms(start):
    return round_ms((time.perf_counter_ns() - start) / 1_000_000)

def round_ms(value):
    return round(value * 1_000) / 1_000

def main():
    payload = json.loads(os.environ["STELLA_ANONYMIZE_DEFAULT_SDK_PERF_PAYLOAD"])
    language = payload["language"]
    result_mode = payload["result_mode"]
    pipeline_options = {} if language is None else {"language": language}
    load_start = time.perf_counter_ns()
    pipeline = anonymize.get_default_native_pipeline(
        **pipeline_options,
        warmup="none",
    )
    load_ms = elapsed_ms(load_start)
    prepare_diagnostics_json = pipeline.prepare_diagnostics_json()
    prepare_top_stages = top_diagnostic_stages(prepare_diagnostics_json)
    prepare_top_slots = top_diagnostic_slots(prepare_diagnostics_json)
    if payload["preload"]:
        warmup_start = time.perf_counter_ns()
        warmup_diagnostics = pipeline.warm_lazy_regex_diagnostics_json()
        warmup_ms = elapsed_ms(warmup_start)
    else:
        warmup_diagnostics = None
        warmup_ms = 0
    warmup_top_stages = top_diagnostic_stages(warmup_diagnostics)
    warmup_top_slots = top_diagnostic_slots(warmup_diagnostics)
    prepare_ms = round_ms(load_ms + warmup_ms)
    cold_run = run_fixtures(pipeline, payload["fixtures"], result_mode)
    run_profile = profile_slowest_fixture(
        pipeline,
        cold_run,
        payload["fixtures"],
    )
    warm_runs = [
        run_fixtures(pipeline, payload["fixtures"], result_mode)
        for _ in range(payload["warm_iterations"])
    ]
    warm_avg_ms = (
        0
        if payload["warm_iterations"] == 0
        else round_ms(sum(run["ms"] for run in warm_runs) / payload["warm_iterations"])
    )
    print(
        json.dumps(
            {
                "event": "native-default-sdk-perf-worker",
                "language": language,
                "preload": payload["preload"],
                "packageBytes": payload["package_bytes"],
                "fixtureCount": len(payload["fixtures"]),
                "loadMs": load_ms,
                "warmupMs": warmup_ms,
                "prepareMs": prepare_ms,
                "runMs": cold_run["ms"],
                "warmAvgMs": warm_avg_ms,
                "prepareTopStages": prepare_top_stages,
                "prepareTopSlots": prepare_top_slots,
                "warmupTopStages": warmup_top_stages,
                "warmupTopSlots": warmup_top_slots,
                "runProfile": run_profile,
                "fixtureTimings": summarize_fixture_timings(cold_run, warm_runs),
                "runTopFixtures": [
                    public_fixture_timing(fixture)
                    for fixture in sorted(
                        cold_run["fixtures"],
                        key=lambda fixture: fixture["ms"],
                        reverse=True,
                    )[:5]
                ],
                "fixtureSignatures": [
                    {
                        "fixture": fixture["fixture"],
                        "signature": fixture["signature"],
                    }
                    for fixture in cold_run["fixtures"]
                ],
            }
        )
    )

main()
`;
}
