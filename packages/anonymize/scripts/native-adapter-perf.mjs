import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT_DIR = join(import.meta.dir, "..", "..", "..");
const ITERATIONS = Number(process.env.ANONYMIZE_NATIVE_PERF_ITERATIONS ?? 100);

const configJson = JSON.stringify({
  regex_patterns: [{ kind: "regex", pattern: "\\b[A-Z]{2}\\d{4}\\b" }],
  custom_regex_patterns: [{ kind: "regex", pattern: "\\bMAT-\\d{3}\\b" }],
  literal_patterns: [
    {
      kind: "literal-with-options",
      pattern: "Secret Code",
      case_insensitive: true,
      whole_words: true,
    },
    {
      kind: "literal-with-options",
      pattern: "Prague",
      case_insensitive: true,
      whole_words: true,
    },
    {
      kind: "literal-with-options",
      pattern: "Acme",
      case_insensitive: true,
      whole_words: false,
    },
    { kind: "fuzzy", pattern: "Fuzztown", distance: 1 },
    {
      kind: "literal-with-options",
      pattern: "Turkey",
      case_insensitive: true,
      whole_words: true,
    },
  ],
  regex_options: { regex_whole_words: false },
  custom_regex_options: { regex_whole_words: false },
  literal_options: {
    literal_case_insensitive: true,
    literal_whole_words: false,
    fuzzy_case_insensitive: true,
    fuzzy_whole_words: true,
    fuzzy_normalize_diacritics: true,
  },
  slices: {
    regex: { start: 0, end: 1 },
    custom_regex: { start: 0, end: 1 },
    deny_list: { start: 0, end: 2 },
    gazetteer: { start: 2, end: 4 },
    countries: { start: 4, end: 5 },
  },
  regex_meta: [{ label: "registration number", score: 0.9 }],
  custom_regex_meta: [
    { label: "matter id", score: 1, source_detail: "custom-regex" },
  ],
  deny_list_data: {
    labels: [["matter"], ["address"]],
    custom_labels: [["matter"], []],
    originals: ["Secret Code", "Prague"],
    sources: [["custom-deny-list"], ["city"]],
    filters: {
      stopwords: [],
      allow_list: [],
      person_stopwords: [],
      address_stopwords: [],
      street_types: [],
      first_names: [],
      generic_roles: [],
      sentence_starters: [],
      trailing_address_word_exclusions: [],
      defined_term_cues: [],
    },
  },
  gazetteer_data: {
    labels: ["organization", "address"],
    is_fuzzy: [false, true],
  },
  country_data: { labels: ["country"] },
});

const pythonScript = `
import importlib.util
import json
import os
import pathlib
import time

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(os.environ["STELLA_ANONYMIZE_PERF_PAYLOAD"])
prepare_start = time.perf_counter_ns()
prepared = module.PreparedSearch(payload["config_json"])
prepare_ms = (time.perf_counter_ns() - prepare_start) / 1_000_000
start = time.perf_counter_ns()
for _ in range(payload["iterations"]):
    for item in payload["cases"]:
        prepared.redact_static_entities(
            item["text"],
            item.get("operators_json"),
        )
elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
print(json.dumps({"prepareMs": prepare_ms, "runMs": elapsed_ms}))
`;

runCommand("cargo", [
  "build",
  "-p",
  "stella-anonymize-napi",
  "-p",
  "stella-anonymize-py",
  "--release",
  "--locked",
]);

const tempDir = mkdtempSync(join(tmpdir(), "stella-anonymize-perf-"));
const napiPath = join(tempDir, "stella_anonymize_napi.node");
const pythonModulePath = join(tempDir, "stella_anonymize_core_py.so");
copyFileSync(nativeLibraryPath("stella_anonymize_napi"), napiPath);
copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), pythonModulePath);

const native = createRequire(import.meta.url)(napiPath);
const cases = buildCases();
const payload = {
  config_json: configJson,
  iterations: ITERATIONS,
  cases: cases.map(({ text, operatorsJson }) => ({
    text,
    operators_json: operatorsJson,
  })),
};

const rustOutput = runCommand(
  "cargo",
  [
    "run",
    "-p",
    "stella-anonymize-adapter-contract",
    "--example",
    "native_adapter_perf",
    "--release",
    "--locked",
  ],
  {
    STELLA_ANONYMIZE_PERF_PAYLOAD: JSON.stringify(payload),
  },
);
const rustSummary = JSON.parse(rustOutput);
printSummary("rust-core", rustSummary, cases.length, ITERATIONS);

const tsPrepareStart = Bun.nanoseconds();
const prepared = new native.NativePreparedSearch(
  toNapiConfig(JSON.parse(configJson)),
);
const tsPrepareMs = elapsedMs(tsPrepareStart);
const tsStart = Bun.nanoseconds();
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  for (const item of cases) {
    prepared.redactStaticEntities(
      item.text,
      item.operatorsJson === undefined
        ? undefined
        : JSON.parse(item.operatorsJson),
    );
  }
}
const tsRunMs = elapsedMs(tsStart);
printSummary(
  "ts-napi",
  { prepareMs: tsPrepareMs, runMs: tsRunMs },
  cases.length,
  ITERATIONS,
);

const pyOutput = runCommand("python3", ["-c", pythonScript], {
  STELLA_ANONYMIZE_PERF_PAYLOAD: JSON.stringify(payload),
  STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
});
const pySummary = JSON.parse(pyOutput);
printSummary("python-pyo3", pySummary, cases.length, ITERATIONS);

function buildCases() {
  const places = ["Fuzztovn", "Fuzztawn", "Fuzztowm"];
  const operators = [
    undefined,
    JSON.stringify({ operators: { country: "redact" } }),
    JSON.stringify({ operators: { address: "redact", country: "redact" } }),
    JSON.stringify({ operators: { matter: "redact" } }),
  ];
  const fixtureCases = [];

  for (let index = 0; index < 24; index += 1) {
    const registration = `AB${String(index).padStart(4, "0")}`;
    const matter = `MAT-${String(index % 1_000).padStart(3, "0")}`;
    const place = places[index % places.length];
    fixtureCases.push({
      text:
        `Reference ${registration} for Acme s.r.o. near ` +
        `${place}, Turkey, Prague, matter ${matter}, code Secret Code.`,
      operatorsJson: operators[index % operators.length],
    });
  }

  return fixtureCases;
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

function printSummary(adapter, summary, fixtureCount, iterations) {
  const calls = fixtureCount * iterations;
  const runMs = Number(summary.runMs);
  const prepareMs = Number(summary.prepareMs);
  console.log(
    JSON.stringify({
      event: "native-adapter-perf",
      adapter,
      fixtureCount,
      iterations,
      calls,
      prepareMs: roundMs(prepareMs),
      runMs: roundMs(runMs),
      totalMs: roundMs(prepareMs + runMs),
      avgCallMs: roundMs(runMs / calls),
    }),
  );
}

function elapsedMs(start) {
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function roundMs(ms) {
  return Math.round(ms * 1_000) / 1_000;
}

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  if (result.status === 0) {
    return result.stdout;
  }

  throw new Error(
    [
      `${command} ${args.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
