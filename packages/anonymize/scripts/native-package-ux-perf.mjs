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

function runScenario({ name, compressed }) {
  const packagePath = join(tempRoot, `${name}.stlanonpkg`);
  const build = runMigration({
    ANONYMIZE_MIGRATION_NATIVE_COMPRESSED_PACKAGE: compressed ? "1" : "0",
    ANONYMIZE_MIGRATION_NATIVE_PREPARED_PACKAGE: "1",
    ANONYMIZE_MIGRATION_WRITE_NATIVE_PACKAGE_PATH: packagePath,
  });
  const load = runMigration({
    ANONYMIZE_MIGRATION_NATIVE_PACKAGE_PATH: packagePath,
  });
  const nativeDiagnostics = load.nativeDiagnostics ?? null;

  return {
    name,
    compressed,
    fixtureCount: load.fixtureCount,
    packageBytes: build.timings.nativePackageBytes,
    offlinePackageBuildMs: build.timings.nativePackagePrepareMs,
    firstPackageReadMs: load.timings.nativePackageReadMs,
    firstPrepareMs: load.timings.nativePrepareMs,
    cachedPrepareMs: load.timings.nativeCachedPrepareAvgMs,
    firstRunMs: load.timings.coldRunMs,
    firstTouchMs: load.timings.nativeFirstTouchMs,
    warmClickMs: load.timings.nativeWarmClickMs,
    prepareTopStages: nativeDiagnostics?.prepare?.topStages ?? [],
    cachedPrepareTopStages: nativeDiagnostics?.cachedPrepare?.topStages ?? [],
    runTopStages: nativeDiagnostics?.run?.topStages ?? [],
    runTopFixtures: nativeDiagnostics?.run?.topFixtures ?? [],
    fixtureTimings: load.fixtureTimings,
    topColdFixtures: load.fixtureTimings.byFixture
      .toSorted((left, right) => right.coldMs - left.coldMs)
      .slice(0, 5),
  };
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
