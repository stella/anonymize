import { spawnSync } from "node:child_process";
import {
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
    });
    printVariantSummary(candidate);

    if (baseline !== null) {
      const comparison = compareSnapshots(baseline, candidate);
      console.log(JSON.stringify(comparison));
      if (!comparison.equal) {
        throw new Error(
          `Fixture parity failed for ${comparison.mismatches.length} fixture(s)`,
        );
      }
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function runVariant({ name, sourceRoot, fixtures, tempRoot }) {
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
  const resultPath = requiredEnv("ANONYMIZE_MIGRATION_RESULT_PATH");
  const fixtures = JSON.parse(requiredEnv("ANONYMIZE_MIGRATION_FIXTURES"));

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
  await indexModule.preparePipelineSearch({ config, context });
  const prepareMs = elapsedMs(prepareStart);

  const coldRun = await runFixtureSweep({
    indexModule,
    config,
    context,
    fixtures,
  });

  const warmRuns = [];
  for (let index = 0; index < WARM_ITERATIONS; index += 1) {
    warmRuns.push(
      await runFixtureSweep({
        indexModule,
        config,
        context,
        fixtures,
      }),
    );
  }

  const warmRunMs = roundMs(warmRuns.reduce((sum, run) => sum + run.ms, 0));
  const warmAvgMs =
    WARM_ITERATIONS === 0 ? 0 : roundMs(warmRunMs / WARM_ITERATIONS);
  const snapshots = Object.fromEntries(
    coldRun.fixtures.map((fixture) => [fixture.fixture, fixture.snapshot]),
  );

  writeFileSync(
    resultPath,
    `${JSON.stringify({
      event: "fixture-migration-variant",
      variant,
      fixtureCount: fixtures.length,
      warmIterations: WARM_ITERATIONS,
      timings: {
        importMs,
        dictionaryMs,
        prepareMs,
        coldRunMs: coldRun.ms,
        coldPipelineMs: roundMs(dictionaryMs + prepareMs + coldRun.ms),
        coldTotalMs: roundMs(importMs + dictionaryMs + prepareMs + coldRun.ms),
        warmRunMs,
        warmAvgMs,
      },
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

async function runFixtureSweep({ indexModule, config, context, fixtures }) {
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
      fixtureCount: result.fixtureCount,
      warmIterations: result.warmIterations,
      timings: result.timings,
      fixtures: result.fixtures,
    }),
  );
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
