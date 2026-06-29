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

if (WORKER) {
  await runWorker();
} else {
  runParent();
}

function runParent() {
  const pythonSdk = preparePythonSdk();
  try {
    const scenarios = scenarioLanguages().map((language) => {
      const tsCold = runWorkerProcess({
        adapter: "ts-node",
        language,
        preload: false,
      });
      const tsPreloaded = runWorkerProcess({
        adapter: "ts-node",
        language,
        preload: true,
      });
      const pythonCold = runWorkerProcess({
        adapter: "python",
        language,
        preload: false,
        pythonSdkRoot: pythonSdk.root,
      });
      const pythonPreloaded = runWorkerProcess({
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
        firstPrepareMs: tsCold.prepareMs,
        firstRunMs: tsCold.runMs,
        firstTouchMs: roundMs(tsCold.prepareMs + tsCold.runMs),
        warmClickMs: tsCold.warmAvgMs,
        setupBeforeClickMs: tsPreloaded.prepareMs,
        preloadedClickMs: tsPreloaded.runMs,
        preloadedWarmClickMs: tsPreloaded.warmAvgMs,
        prepareTopStages: tsCold.prepareTopStages,
        preloadedPrepareTopStages: tsPreloaded.prepareTopStages,
        runTopFixtures: tsCold.runTopFixtures,
        fixtureTimings: tsCold.fixtureTimings,
        preloadedFixtureTimings: tsPreloaded.fixtureTimings,
        adapters,
      };
    });

    console.log(
      JSON.stringify({
        event: "native-default-sdk-perf",
        scenarios,
      }),
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
        .slice(0, 5)
        .map(publicFixtureTiming),
      fixtureSignatures: coldRun.fixtures.map(({ fixture, signature }) => ({
        fixture,
        signature,
      })),
    }),
  );
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

function runPythonWorker({ language, fixtures, packageBytes }) {
  if (PYTHON_SDK_ROOT.length === 0) {
    throw new Error("Python SDK root is required for the Python perf worker");
  }
  const payload = {
    language: language.length === 0 ? null : language,
    preload: PRELOAD,
    package_bytes: packageBytes,
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
    const result = pipeline.redactText(fixture.text);
    results.push({
      fixture: fixture.fixture,
      ms: elapsedMs(fixtureStart),
      entityCount: result.redaction.entityCount,
      redactedTextLength: result.redaction.redactedText.length,
      signature: hashSignature(canonicalNativeResult(result)),
    });
  }
  return {
    ms: elapsedMs(started),
    fixtures: results,
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

function pythonWorkerScript() {
  return String.raw`
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.environ["STELLA_ANONYMIZE_PYTHON_SDK_ROOT"])

import stella_anonymize as anonymize

def run_fixtures(pipeline, fixtures):
    started = time.perf_counter_ns()
    results = []
    for fixture in fixtures:
        fixture_start = time.perf_counter_ns()
        result = pipeline.redact_text(fixture["text"])
        results.append(
            {
                "fixture": fixture["fixture"],
                "ms": elapsed_ms(fixture_start),
                "entityCount": result.redaction.entity_count,
                "redactedTextLength": len(result.redaction.redacted_text),
                "signature": hash_signature(canonical_result(result)),
            }
        )
    return {"ms": elapsed_ms(started), "fixtures": results}

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

def hash_signature(value):
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:16]

def top_diagnostic_stages(diagnostics_json):
    if diagnostics_json is None:
        return []
    parsed = json.loads(diagnostics_json)
    events = parsed.get("events") or parsed.get("diagnostics", {}).get("events")
    if not isinstance(events, list):
        return []
    stages = []
    for event in events:
        stage = event.get("stage")
        elapsed_us = event.get("elapsed_us")
        if not isinstance(stage, str) or not isinstance(elapsed_us, (int, float)):
            continue
        stages.append(
            {
                "stage": stage,
                "elapsedMs": round_ms(elapsed_us / 1_000),
                "count": event.get("count") if isinstance(event.get("count"), int) else None,
                "inputBytes": event.get("input_bytes") if isinstance(event.get("input_bytes"), int) else None,
            }
        )
    return sorted(stages, key=lambda event: event["elapsedMs"], reverse=True)[:10]

def elapsed_ms(start):
    return round_ms((time.perf_counter_ns() - start) / 1_000_000)

def round_ms(value):
    return round(value * 1_000) / 1_000

def main():
    payload = json.loads(os.environ["STELLA_ANONYMIZE_DEFAULT_SDK_PERF_PAYLOAD"])
    language = payload["language"]
    pipeline_options = {} if language is None else {"language": language}
    prepare_start = time.perf_counter_ns()
    if payload["preload"]:
        pipeline = anonymize.preload_default_native_pipeline(**pipeline_options)
    else:
        pipeline = anonymize.get_default_native_pipeline(**pipeline_options)
    prepare_ms = (time.perf_counter_ns() - prepare_start) / 1_000_000
    prepare_top_stages = top_diagnostic_stages(pipeline.prepare_diagnostics_json())
    cold_run = run_fixtures(pipeline, payload["fixtures"])
    warm_runs = [
        run_fixtures(pipeline, payload["fixtures"])
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
                "prepareMs": round_ms(prepare_ms),
                "runMs": cold_run["ms"],
                "warmAvgMs": warm_avg_ms,
                "prepareTopStages": prepare_top_stages,
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
