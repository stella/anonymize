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
  const noWarmDiagnostics = noWarmLoad.nativeDiagnostics ?? null;
  const preloadedDiagnostics = preloadedLoad.nativeDiagnostics ?? null;

  return {
    name,
    compressed,
    language: language ?? null,
    userDataScenario: userDataScenario ?? "none",
    fixtureCount: noWarmLoad.fixtureCount,
    packageBytes: build.timings.nativePackageBytes,
    offlinePackageBuildMs: build.timings.nativePackagePrepareMs,
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
    prepareTopStages: noWarmDiagnostics?.prepare?.topStages ?? [],
    prepareArtifacts: summarizePrepareArtifacts(
      noWarmDiagnostics?.prepare?.stages ?? [],
    ),
    warmTopStages: preloadedDiagnostics?.warm?.topStages ?? [],
    cachedPrepareTopStages: noWarmDiagnostics?.cachedPrepare?.topStages ?? [],
    runTopStages: noWarmDiagnostics?.run?.topStages ?? [],
    runTopSlots: noWarmDiagnostics?.run?.topSlots ?? [],
    runTopFixtures: noWarmDiagnostics?.run?.topFixtures ?? [],
    fixtureTimings: noWarmLoad.fixtureTimings,
    preloadedFixtureTimings: preloadedLoad.fixtureTimings,
    topColdFixtures: noWarmLoad.fixtureTimings.byFixture
      .toSorted((left, right) => right.coldMs - left.coldMs)
      .slice(0, 5),
  };
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
