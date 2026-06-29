import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_DIR = dirname(dirname(SCRIPT_PATH));
const ROOT_DIR = resolve(join(PACKAGE_DIR, "..", ".."));
const MIGRATION_SCRIPT = join(
  PACKAGE_DIR,
  "scripts",
  "migration-fixture-perf.mjs",
);
const ITERATIONS = positiveIntegerFromEnv(
  "ANONYMIZE_NATIVE_PACKAGE_UX_ITERATIONS",
  1,
);
const NUMERIC_SAMPLE_FIELDS = [
  "firstPackageReadMs",
  "firstPrepareMs",
  "firstWarmPrepareMs",
  "loadPrepareMs",
  "setupBeforeClickMs",
  "cachedPrepareMs",
  "cachedWarmPrepareMs",
  "firstRunMs",
  "preloadedClickMs",
  "firstTouchMs",
  "warmClickMs",
];

const SCENARIOS = [
  { name: "compressed", compressed: true },
  { name: "raw", compressed: false },
  ...languageScenarios(),
  ...userDataScenarios(),
];

const tempRoot = mkdtempSync(join(tmpdir(), "stella-anonymize-package-ux-"));

try {
  const scenarios = SCENARIOS.map((scenario) => runScenario(scenario));
  console.log(
    JSON.stringify({
      event: "native-package-ux-perf",
      scenarios,
    }),
  );
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}

function runScenario({ name, compressed, language, userDataScenario }) {
  const packagePath = join(tempRoot, `${name}.stlanonpkg`);
  const languageEnv =
    language === undefined
      ? {}
      : {
          ANONYMIZE_MIGRATION_CONTENT_LANGUAGE: language,
          ANONYMIZE_MIGRATION_FIXTURE_LANGUAGES: language,
        };
  const userDataEnv =
    userDataScenario === undefined || userDataScenario === "none"
      ? {}
      : {
          ANONYMIZE_MIGRATION_USER_DATA_SCENARIO: userDataScenario,
        };
  const build = runMigration({
    ...languageEnv,
    ...userDataEnv,
    ANONYMIZE_MIGRATION_NATIVE_COMPRESSED_PACKAGE: compressed ? "1" : "0",
    ANONYMIZE_MIGRATION_NATIVE_PREPARED_PACKAGE: "1",
    ANONYMIZE_MIGRATION_WRITE_NATIVE_PACKAGE_PATH: packagePath,
  });
  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const noWarmLoad = runMigration({
      ...languageEnv,
      ...userDataEnv,
      ANONYMIZE_MIGRATION_NATIVE_PACKAGE_PATH: packagePath,
      ANONYMIZE_MIGRATION_NATIVE_PREPARE_WARMUP: "none",
    });
    const preloadedLoad = runMigration({
      ...languageEnv,
      ...userDataEnv,
      ANONYMIZE_MIGRATION_NATIVE_PACKAGE_PATH: packagePath,
      ANONYMIZE_MIGRATION_NATIVE_PREPARE_WARMUP: "diagnostics",
    });
    samples.push(createScenarioSample(index + 1, noWarmLoad, preloadedLoad));
  }
  const representativeSample = sampleNearestMedian(samples, "firstRunMs");
  const stats = numericSampleStats(samples);

  return {
    name,
    compressed,
    language: language ?? null,
    userDataScenario: userDataScenario ?? "none",
    iterations: ITERATIONS,
    fixtureCount: representativeSample.fixtureCount,
    packageBytes: build.timings.nativePackageBytes,
    offlinePackageBuildMs: build.timings.nativePackagePrepareMs,
    ...medianFields(stats),
    stats,
    samples: samples.map(compactScenarioSample),
    prepareTopStages:
      representativeSample.noWarmDiagnostics?.prepare?.topStages ?? [],
    prepareArtifacts: summarizePrepareArtifacts(
      representativeSample.noWarmDiagnostics?.prepare?.stages ?? [],
    ),
    warmTopStages:
      representativeSample.preloadedDiagnostics?.warm?.topStages ?? [],
    cachedPrepareTopStages:
      representativeSample.noWarmDiagnostics?.cachedPrepare?.topStages ?? [],
    runTopStages: representativeSample.noWarmDiagnostics?.run?.topStages ?? [],
    runTopSlots: representativeSample.noWarmDiagnostics?.run?.topSlots ?? [],
    runTopFixtures:
      representativeSample.noWarmDiagnostics?.run?.topFixtures ?? [],
    fixtureTimings: representativeSample.fixtureTimings,
    preloadedFixtureTimings: representativeSample.preloadedFixtureTimings,
    topColdFixtures: representativeSample.fixtureTimings.byFixture
      .toSorted((left, right) => right.coldMs - left.coldMs)
      .slice(0, 5),
  };
}

function createScenarioSample(iteration, noWarmLoad, preloadedLoad) {
  return {
    iteration,
    fixtureCount: noWarmLoad.fixtureCount,
    firstPackageReadMs: noWarmLoad.timings.nativePackageReadMs,
    firstPrepareMs: noWarmLoad.timings.nativePrepareMs,
    firstWarmPrepareMs: preloadedLoad.timings.nativeWarmPrepareMs,
    loadPrepareMs:
      noWarmLoad.timings.nativePackageReadMs +
      noWarmLoad.timings.nativePrepareMs,
    setupBeforeClickMs:
      preloadedLoad.timings.nativePackageReadMs +
      preloadedLoad.timings.nativePrepareMs +
      preloadedLoad.timings.nativeWarmPrepareMs,
    cachedPrepareMs: noWarmLoad.timings.nativeCachedPrepareAvgMs,
    cachedWarmPrepareMs: preloadedLoad.timings.nativeCachedWarmPrepareAvgMs,
    firstRunMs: noWarmLoad.timings.coldRunMs,
    preloadedClickMs: preloadedLoad.timings.coldRunMs,
    firstTouchMs: noWarmLoad.timings.nativeFirstTouchMs,
    warmClickMs: noWarmLoad.timings.nativeWarmClickMs,
    noWarmDiagnostics: noWarmLoad.nativeDiagnostics ?? null,
    preloadedDiagnostics: preloadedLoad.nativeDiagnostics ?? null,
    fixtureTimings: noWarmLoad.fixtureTimings,
    preloadedFixtureTimings: preloadedLoad.fixtureTimings,
  };
}

function compactScenarioSample(sample) {
  const compact = { iteration: sample.iteration };
  for (const field of NUMERIC_SAMPLE_FIELDS) {
    compact[field] = sample[field];
  }
  return compact;
}

function numericSampleStats(samples) {
  const stats = {};
  for (const field of NUMERIC_SAMPLE_FIELDS) {
    const values = samples.map((sample) => sample[field]);
    stats[field] = numericStats(values);
  }
  return stats;
}

function medianFields(stats) {
  const fields = {};
  for (const [field, fieldStats] of Object.entries(stats)) {
    fields[field] = fieldStats.median;
  }
  return fields;
}

function numericStats(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted.at(0) ?? 0,
    median: medianSorted(sorted),
    avg: sum / values.length,
    max: sorted.at(-1) ?? 0,
  };
}

function medianSorted(sorted) {
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleNearestMedian(samples, field) {
  const median = numericStats(samples.map((sample) => sample[field])).median;
  return samples.toSorted(
    (left, right) =>
      Math.abs(left[field] - median) - Math.abs(right[field] - median),
  )[0];
}

function languageScenarios() {
  const value = process.env.ANONYMIZE_NATIVE_PACKAGE_UX_LANGUAGES ?? "en,cs,de";
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => normalizeLanguage(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .map((language) => ({
      name: `compressed-${language}`,
      compressed: true,
      language,
    }));
}

function normalizeLanguage(value) {
  const language = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(language)) {
    throw new Error(
      `Invalid ANONYMIZE_NATIVE_PACKAGE_UX_LANGUAGES entry: ${value}`,
    );
  }
  return language;
}

function userDataScenarios() {
  const value =
    process.env.ANONYMIZE_NATIVE_PACKAGE_UX_USER_DATA_SCENARIOS ??
    "sample,heavy";
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => normalizeUserDataScenario(entry))
    .filter((entry) => entry !== "none")
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .map((userDataScenario) => ({
      name: `compressed-user-${userDataScenario}`,
      compressed: true,
      userDataScenario,
    }));
}

function normalizeUserDataScenario(value) {
  const scenario = value.trim().toLowerCase();
  if (scenario === "none" || scenario === "sample" || scenario === "heavy") {
    return scenario;
  }
  throw new Error(
    `ANONYMIZE_NATIVE_PACKAGE_UX_USER_DATA_SCENARIOS must contain none, sample, or heavy; got ${value}`,
  );
}

function positiveIntegerFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; got ${value}`);
  }
  return parsed;
}

function runMigration(extraEnv) {
  const child = spawnSync(process.execPath, [MIGRATION_SCRIPT], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...extraEnv,
      ANONYMIZE_MIGRATION_CANDIDATE_RUNTIME: "native-static",
      ANONYMIZE_MIGRATION_COMPARE_BASELINE: "0",
      ANONYMIZE_MIGRATION_REQUIRE_NATIVE_PIPELINE: "1",
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (child.status !== 0) {
    throw new Error(
      [
        "Native package UX benchmark failed",
        child.stdout.trim(),
        child.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return parseVariant(child.stdout);
}

function summarizePrepareArtifacts(stages) {
  const artifactStages = stages.filter(
    (stage) =>
      typeof stage.artifactBytes === "number" && stage.artifactBytes > 0,
  );
  const byStage = new Map();
  for (const stage of artifactStages) {
    const bucket = byStage.get(stage.stage) ?? {
      stage: stage.stage,
      artifactBytes: 0,
      artifactCount: 0,
      patternCount: 0,
      slots: 0,
    };
    bucket.artifactBytes += stage.artifactBytes;
    bucket.artifactCount += stage.artifactCount ?? 0;
    bucket.patternCount += stage.patternCount ?? 0;
    bucket.slots += 1;
    byStage.set(stage.stage, bucket);
  }
  return {
    totalBytes: artifactStages.reduce(
      (sum, stage) => sum + stage.artifactBytes,
      0,
    ),
    byStage: [...byStage.values()].sort(
      (left, right) => right.artifactBytes - left.artifactBytes,
    ),
    topSlots: artifactStages
      .map((stage) => ({
        stage: stage.stage,
        engine: stage.engine,
        slot: stage.slot,
        subslot: stage.subslot,
        pattern: stage.pattern,
        patternCount: stage.patternCount,
        artifactCount: stage.artifactCount,
        artifactBytes: stage.artifactBytes,
      }))
      .sort((left, right) => right.artifactBytes - left.artifactBytes)
      .slice(0, 10),
  };
}

function parseVariant(stdout) {
  for (const line of stdout.trim().split("\n").toReversed()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "fixture-migration-variant") {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error("Migration benchmark did not emit a variant summary");
}
