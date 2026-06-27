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
  const load = runMigration({
    ...languageEnv,
    ...userDataEnv,
    ANONYMIZE_MIGRATION_NATIVE_PACKAGE_PATH: packagePath,
  });
  const nativeDiagnostics = load.nativeDiagnostics ?? null;

  return {
    name,
    compressed,
    language: language ?? null,
    userDataScenario: userDataScenario ?? "none",
    fixtureCount: load.fixtureCount,
    packageBytes: build.timings.nativePackageBytes,
    offlinePackageBuildMs: build.timings.nativePackagePrepareMs,
    firstPackageReadMs: load.timings.nativePackageReadMs,
    firstPrepareMs: load.timings.nativePrepareMs,
    firstWarmPrepareMs: load.timings.nativeWarmPrepareMs,
    setupBeforeClickMs:
      load.timings.nativePackageReadMs + load.timings.nativePrepareMs,
    cachedPrepareMs: load.timings.nativeCachedPrepareAvgMs,
    cachedWarmPrepareMs: load.timings.nativeCachedWarmPrepareAvgMs,
    firstRunMs: load.timings.coldRunMs,
    preloadedClickMs: load.timings.coldRunMs,
    firstTouchMs: load.timings.nativeFirstTouchMs,
    warmClickMs: load.timings.nativeWarmClickMs,
    prepareTopStages: nativeDiagnostics?.prepare?.topStages ?? [],
    cachedPrepareTopStages: nativeDiagnostics?.cachedPrepare?.topStages ?? [],
    runTopStages: nativeDiagnostics?.run?.topStages ?? [],
    runTopSlots: nativeDiagnostics?.run?.topSlots ?? [],
    runTopFixtures: nativeDiagnostics?.run?.topFixtures ?? [],
    fixtureTimings: load.fixtureTimings,
    topColdFixtures: load.fixtureTimings.byFixture
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
