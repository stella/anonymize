import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
const WARM_ITERATIONS = positiveIntegerEnv(
  "ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WARM_ITERATIONS",
  1,
);

if (WORKER) {
  await runWorker();
} else {
  runParent();
}

function runParent() {
  const scenarios = scenarioLanguages().map((language) => {
    const cold = runWorkerProcess({ language, preload: false });
    const preloaded = runWorkerProcess({ language, preload: true });
    return {
      name: language === "" ? "default" : `default-${language}`,
      language: language === "" ? null : language,
      packageBytes: cold.packageBytes,
      fixtureCount: cold.fixtureCount,
      firstPrepareMs: cold.prepareMs,
      firstRunMs: cold.runMs,
      firstTouchMs: roundMs(cold.prepareMs + cold.runMs),
      warmClickMs: cold.warmAvgMs,
      setupBeforeClickMs: preloaded.prepareMs,
      preloadedClickMs: preloaded.runMs,
      preloadedWarmClickMs: preloaded.warmAvgMs,
      prepareTopStages: cold.prepareTopStages,
      preloadedPrepareTopStages: preloaded.prepareTopStages,
      runTopFixtures: cold.runTopFixtures,
      fixtureTimings: cold.fixtureTimings,
      preloadedFixtureTimings: preloaded.fixtureTimings,
    };
  });

  console.log(
    JSON.stringify({
      event: "native-default-sdk-perf",
      scenarios,
    }),
  );
}

async function runWorker() {
  const language = LANGUAGE.trim().toLowerCase();
  const pipelineOptions = language.length === 0 ? {} : { language };
  const fixtures = loadFixtures(language);
  const packageBytes = defaultPackageBytes(language);
  const nativeNode = await import("../src/native-node.ts");

  const prepareStart = Bun.nanoseconds();
  const pipeline = PRELOAD
    ? nativeNode.preloadDefaultNativePipeline(pipelineOptions)
    : nativeNode.getDefaultNativePipeline(pipelineOptions);
  const prepareMs = elapsedMs(prepareStart);
  const prepareTopStages = topDiagnosticStages(
    pipeline.prepareDiagnosticsJson(),
  );

  const coldRun = runFixtures(pipeline, fixtures);
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
      prepareMs,
      runMs: coldRun.ms,
      warmAvgMs,
      prepareTopStages,
      fixtureTimings: summarizeFixtureTimings(coldRun, warmRuns),
      runTopFixtures: coldRun.fixtures
        .toSorted((left, right) => right.ms - left.ms)
        .slice(0, 5),
    }),
  );
}

function runWorkerProcess({ language, preload }) {
  const child = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WORKER: "1",
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_PRELOAD: preload ? "1" : "0",
      ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGE: language,
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

function runFixtures(pipeline, fixtures) {
  const started = Bun.nanoseconds();
  const results = [];
  for (const fixture of fixtures) {
    const fixtureStart = Bun.nanoseconds();
    const result = pipeline.redactText(fixture.text);
    results.push({
      fixture: fixture.fixture,
      ms: elapsedMs(fixtureStart),
      entityCount: result.redaction.entityCount,
      redactedTextLength: result.redaction.redactedText.length,
    });
  }
  return {
    ms: elapsedMs(started),
    fixtures: results,
  };
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
  if (diagnosticsJson === null) {
    return [];
  }
  const parsed = JSON.parse(diagnosticsJson);
  const events = parsed.events ?? parsed.diagnostics?.events;
  if (!Array.isArray(events)) {
    return [];
  }
  return events
    .filter((event) => typeof event.stage === "string")
    .map((event) => ({
      stage: event.stage,
      elapsedMs:
        typeof event.elapsed_us === "number"
          ? roundMs(event.elapsed_us / 1_000)
          : null,
      count: typeof event.count === "number" ? event.count : null,
      inputBytes:
        typeof event.input_bytes === "number" ? event.input_bytes : null,
    }))
    .filter((event) => event.elapsedMs !== null)
    .toSorted((left, right) => (right.elapsedMs ?? 0) - (left.elapsedMs ?? 0))
    .slice(0, 10);
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
  const packagePath =
    language.length === 0
      ? join(PACKAGE_DIR, "native-pipeline.stlanonpkg")
      : join(
          PACKAGE_DIR,
          `native-pipeline.${normalizeLanguage(language)}.stlanonpkg`,
        );
  if (!existsSync(packagePath)) {
    throw new Error(
      `Default native pipeline package is missing: ${packagePath}`,
    );
  }
  return statSync(packagePath).size;
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
