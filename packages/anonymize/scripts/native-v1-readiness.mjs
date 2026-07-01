import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_DIR = dirname(dirname(SCRIPT_PATH));
const ROOT_DIR = resolve(join(PACKAGE_DIR, "..", ".."));
const MODE = readMode();
const MB = 1024 * 1024;

const PACKAGE_BUDGETS = {
  default: { failMb: 40, warnMb: 30 },
  language: { failMb: 14, warnMb: 8 },
};

const DEFAULT_SDK_BUDGETS = {
  default: {
    firstTouchMs: { fail: 1200, warn: 350 },
    warmClickMs: { fail: 250, warn: 50 },
    preloadedClickMs: { fail: 250, warn: 50 },
  },
  language: {
    firstTouchMs: { fail: 700, warn: 200 },
    warmClickMs: { fail: 180, warn: 40 },
    preloadedClickMs: { fail: 180, warn: 40 },
  },
};

const PACKAGE_UX_BUDGETS = {
  default: {
    firstTouchMs: { fail: 1200, warn: 350 },
    warmClickMs: { fail: 250, warn: 50 },
    preloadedClickMs: { fail: 250, warn: 50 },
  },
  language: {
    firstTouchMs: { fail: 700, warn: 200 },
    warmClickMs: { fail: 180, warn: 40 },
    preloadedClickMs: { fail: 180, warn: 40 },
  },
  userData: {
    firstTouchMs: { fail: 1500, warn: 500 },
    warmClickMs: { fail: 350, warn: 80 },
    preloadedClickMs: { fail: 350, warn: 80 },
  },
};

const checks = [];
const reports = {};

checkPackageArtifacts();
runDefaultSdkReadiness();
runPackageUxReadiness();

const failedCount = checks.filter((check) => check.status === "fail").length;
const warningCount = checks.filter((check) => check.status === "warn").length;
const result = {
  event: "native-v1-readiness",
  mode: MODE,
  failedCount,
  warningCount,
  checks,
  reports,
};

console.log(JSON.stringify(result, null, 2));

if (failedCount > 0) {
  process.exitCode = 1;
}

function checkPackageArtifacts() {
  checkPackageArtifact({
    name: "default package",
    path: join(PACKAGE_DIR, "native-pipeline.stlanonpkg"),
    budgets: PACKAGE_BUDGETS.default,
  });

  for (const language of packageLanguages()) {
    checkPackageArtifact({
      name: `language package ${language}`,
      path: join(PACKAGE_DIR, `native-pipeline.${language}.stlanonpkg`),
      budgets: PACKAGE_BUDGETS.language,
    });
  }
}

function checkPackageArtifact({ name, path, budgets }) {
  if (!existsSync(path)) {
    addCheck({
      name,
      status: "fail",
      message: `Missing ${path}`,
    });
    return;
  }

  const bytes = statSync(path).size;
  const sizeMb = roundMetric(bytes / MB);
  addBudgetCheck({
    name,
    metric: "packageMb",
    value: sizeMb,
    warnLimit: budgets.warnMb,
    failLimit: budgets.failMb,
  });
}

function runDefaultSdkReadiness() {
  if (process.env.ANONYMIZE_V1_READINESS_SKIP_DEFAULT_SDK === "1") {
    addCheck({
      name: "default sdk parity and perf",
      status: "warn",
      message: "Skipped by ANONYMIZE_V1_READINESS_SKIP_DEFAULT_SDK=1",
    });
    return;
  }

  const report = runJsonScript("native-default-sdk-perf.mjs", {
    ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_OUTPUT: "summary",
    ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGES:
      process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_LANGUAGES ??
      defaultSdkLanguages(),
    ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_REPEATS:
      process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_REPEATS ??
      (MODE === "full" ? "3" : "1"),
    ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WARM_ITERATIONS:
      process.env.ANONYMIZE_NATIVE_DEFAULT_SDK_PERF_WARM_ITERATIONS ??
      (MODE === "full" ? "5" : "2"),
  });

  reports.defaultSdk = compactDefaultSdkReport(report);
  checkDefaultSdkReport(report);
}

function checkDefaultSdkReport(report) {
  if (report.event !== "native-default-sdk-perf-summary") {
    addCheck({
      name: "default sdk report",
      status: "fail",
      message: `Unexpected event ${String(report.event)}`,
    });
    return;
  }

  addCheck({
    name: "default sdk fixture parity",
    status: "pass",
    message: "TS and Python fixture signatures matched",
  });

  for (const scenario of report.scenarios ?? []) {
    for (const adapter of scenario.adapters ?? []) {
      const budgets =
        scenario.language === null
          ? DEFAULT_SDK_BUDGETS.default
          : DEFAULT_SDK_BUDGETS.language;
      checkPerfFields({
        prefix: `default sdk ${scenario.name}/${adapter.adapter}`,
        metrics: adapter,
        budgets,
      });
    }
  }
}

function compactDefaultSdkReport(report) {
  return {
    event: report.event,
    resultMode: report.resultMode,
    repeats: report.repeats,
    scenarios: (report.scenarios ?? []).map((scenario) => ({
      name: scenario.name,
      language: scenario.language,
      packageMb: scenario.packageMb,
      fixtureCount: scenario.fixtureCount,
      adapters: (scenario.adapters ?? []).map((adapter) => ({
        adapter: adapter.adapter,
        firstTouchMs: adapter.firstTouchMs,
        warmClickMs: adapter.warmClickMs,
        preloadedClickMs: adapter.preloadedClickMs,
      })),
    })),
  };
}

function runPackageUxReadiness() {
  if (process.env.ANONYMIZE_V1_READINESS_SKIP_PACKAGE_UX === "1") {
    addCheck({
      name: "package ux perf",
      status: "warn",
      message: "Skipped by ANONYMIZE_V1_READINESS_SKIP_PACKAGE_UX=1",
    });
    return;
  }

  const report = runJsonScript("native-package-ux-perf.mjs", {
    ANONYMIZE_NATIVE_PACKAGE_UX_ITERATIONS:
      process.env.ANONYMIZE_NATIVE_PACKAGE_UX_ITERATIONS ??
      (MODE === "full" ? "3" : "1"),
    ANONYMIZE_NATIVE_PACKAGE_UX_LANGUAGES:
      process.env.ANONYMIZE_NATIVE_PACKAGE_UX_LANGUAGES ??
      (MODE === "full" ? "en,cs,de" : "en"),
    ANONYMIZE_NATIVE_PACKAGE_UX_USER_DATA_SCENARIOS:
      process.env.ANONYMIZE_NATIVE_PACKAGE_UX_USER_DATA_SCENARIOS ??
      (MODE === "full" ? "sample,heavy" : ""),
  });

  reports.packageUx = compactPackageUxReport(report);
  checkPackageUxReport(report);
}

function checkPackageUxReport(report) {
  if (report.event !== "native-package-ux-perf") {
    addCheck({
      name: "package ux report",
      status: "fail",
      message: `Unexpected event ${String(report.event)}`,
    });
    return;
  }

  for (const scenario of report.scenarios ?? []) {
    const budgets = packageUxBudgetsForScenario(scenario);
    checkPerfFields({
      prefix: `package ux ${scenario.name}`,
      metrics: scenario,
      budgets,
    });
  }
}

function packageUxBudgetsForScenario(scenario) {
  if (scenario.userDataScenario !== "none") {
    return PACKAGE_UX_BUDGETS.userData;
  }
  if (scenario.language === null) {
    return PACKAGE_UX_BUDGETS.default;
  }
  return PACKAGE_UX_BUDGETS.language;
}

function compactPackageUxReport(report) {
  return {
    event: report.event,
    scenarios: (report.scenarios ?? []).map((scenario) => ({
      name: scenario.name,
      language: scenario.language,
      userDataScenario: scenario.userDataScenario,
      packageMb: roundMetric((scenario.packageBytes ?? 0) / MB),
      offlinePackageBuildMs: scenario.offlinePackageBuildMs,
      firstPackageReadMs: scenario.firstPackageReadMs,
      firstPrepareMs: scenario.firstPrepareMs,
      firstRunMs: scenario.firstRunMs,
      firstTouchMs: scenario.firstTouchMs,
      warmClickMs: scenario.warmClickMs,
      preloadedClickMs: scenario.preloadedClickMs,
    })),
  };
}

function checkPerfFields({ prefix, metrics, budgets }) {
  for (const [metric, budget] of Object.entries(budgets)) {
    const value = metrics[metric];
    if (typeof value !== "number") {
      addCheck({
        name: `${prefix} ${metric}`,
        status: "fail",
        message: "Metric is missing",
      });
      continue;
    }

    addBudgetCheck({
      name: `${prefix} ${metric}`,
      metric,
      value: roundMetric(value),
      warnLimit: budget.warn,
      failLimit: budget.fail,
    });
  }
}

function addBudgetCheck({ name, metric, value, warnLimit, failLimit }) {
  if (value > failLimit) {
    addCheck({
      name,
      status: "fail",
      metric,
      value,
      limit: failLimit,
      message: `${metric} is above the hard v1 limit`,
    });
    return;
  }

  if (value > warnLimit) {
    addCheck({
      name,
      status: "warn",
      metric,
      value,
      limit: warnLimit,
      message: `${metric} is above the target budget`,
    });
    return;
  }

  addCheck({
    name,
    status: "pass",
    metric,
    value,
    limit: warnLimit,
  });
}

function addCheck(check) {
  checks.push(check);
}

function runJsonScript(scriptName, env) {
  const scriptPath = join(PACKAGE_DIR, "scripts", scriptName);
  const commandResult = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 128,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (commandResult.status !== 0) {
    throw new Error(
      [
        `${scriptName} failed with exit code ${String(commandResult.status)}`,
        commandResult.stdout.trim(),
        commandResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const jsonLine = commandResult.stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((line) => line.trim().length > 0);

  if (jsonLine === undefined) {
    throw new Error(`${scriptName} did not emit JSON`);
  }

  try {
    return JSON.parse(jsonLine);
  } catch (error) {
    throw new Error(
      `${scriptName} emitted invalid JSON: ${String(error)}\n${jsonLine}`,
    );
  }
}

function packageLanguages() {
  const fallback = MODE === "full" ? ["cs", "de", "en"] : ["en"];
  return languageListFromEnv(
    "ANONYMIZE_V1_READINESS_PACKAGE_LANGUAGES",
    fallback,
  );
}

function defaultSdkLanguages() {
  if (MODE === "full") {
    return "all,cs,de,en";
  }
  return "all,en";
}

function languageListFromEnv(name, fallback) {
  const raw = process.env[name];
  const entries = raw === undefined ? fallback : raw.split(",");
  return entries
    .map((entry) => normalizeLanguage(entry))
    .filter((entry) => entry.length > 0)
    .filter((entry, index, allEntries) => allEntries.indexOf(entry) === index);
}

function normalizeLanguage(value) {
  const language = value.trim().toLowerCase();
  if (language.length === 0) {
    return "";
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(language)) {
    throw new Error(`Invalid language entry: ${value}`);
  }
  return language;
}

function readMode() {
  const value = process.env.ANONYMIZE_V1_READINESS_MODE ?? "quick";
  const mode = value.trim().toLowerCase();
  if (mode === "quick" || mode === "full") {
    return mode;
  }
  throw new Error("ANONYMIZE_V1_READINESS_MODE must be quick or full");
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}
