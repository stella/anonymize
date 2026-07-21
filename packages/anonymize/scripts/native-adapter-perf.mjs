import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  load_prepared_package,
  prepare_search_package,
  redact_text as redactTextWithSdk,
} from "../src/native.ts";

const ROOT_DIR = join(import.meta.dir, "..", "..", "..");
const ITERATIONS = Number(process.env.ANONYMIZE_NATIVE_PERF_ITERATIONS ?? 100);
const TOP_LEVEL_ITERATIONS = Number(
  process.env.ANONYMIZE_NATIVE_PERF_TOP_LEVEL_ITERATIONS ??
    Math.min(ITERATIONS, 10),
);
const USER_DATA_SCENARIOS = userDataScenarios();

const BASE_CONFIG = {
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
  country_data: {
    labels: ["country"],
    isoCodes: ["TR"],
    variants: ["name"],
  },
};

const pythonScript = `
import importlib.util
import json
import os
import pathlib
import time

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
spec = importlib.util.spec_from_file_location(
    "_native",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload_path = os.environ.get("STELLA_ANONYMIZE_PERF_PAYLOAD_PATH")
if payload_path is not None:
    payload = json.loads(pathlib.Path(payload_path).read_text())
else:
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
case_results = [
    json.loads(
        prepared.redact_static_entities_json(
            item["text"],
            item.get("operators_json"),
        )
    )
    for item in payload["cases"]
]
print(json.dumps({"prepareMs": prepare_ms, "runMs": elapsed_ms, "caseResults": case_results}))
`;

const pythonSdkScript = `
import json
import os
import pathlib
import sys
import time

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

payload_path = os.environ.get("STELLA_ANONYMIZE_PERF_PAYLOAD_PATH")
if payload_path is not None:
    payload = json.loads(pathlib.Path(payload_path).read_text())
else:
    payload = json.loads(os.environ["STELLA_ANONYMIZE_PERF_PAYLOAD"])
package_start = time.perf_counter_ns()
package_bytes = anonymize.prepare_search_package(payload["config_json"])
package_prepare_ms = (time.perf_counter_ns() - package_start) / 1_000_000
load_start = time.perf_counter_ns()
prepared = anonymize.load_prepared_package(package_bytes)
load_ms = (time.perf_counter_ns() - load_start) / 1_000_000
def entity_to_dict(entity):
    return {
        "start": entity.start,
        "end": entity.end,
        "label": entity.label,
        "text": entity.text,
        "score": entity.score,
        "source": entity.source,
        "source_detail": entity.source_detail,
    }

def redaction_entry_to_dict(entry):
    return {"placeholder": entry.placeholder, "original": entry.original}

def operator_entry_to_dict(entry):
    return {"placeholder": entry.placeholder, "operator": entry.operator}

def result_to_dict(result):
    return {
        "resolved_entities": [
            entity_to_dict(entity)
            for entity in result.resolved_entities
        ],
        "redaction": {
            "redacted_text": result.redaction.redacted_text,
            "redaction_map": [
                redaction_entry_to_dict(entry)
                for entry in result.redaction.redaction_map
            ],
            "operator_map": [
                operator_entry_to_dict(entry)
                for entry in result.redaction.operator_map
            ],
            "entity_count": result.redaction.entity_count,
        },
    }
start = time.perf_counter_ns()
for _ in range(payload["iterations"]):
    for item in payload["cases"]:
        prepared.redact_text(
            item["text"],
            item.get("operators"),
        )
run_ms = (time.perf_counter_ns() - start) / 1_000_000
one_shot_start = time.perf_counter_ns()
for _ in range(payload["top_level_iterations"]):
    for item in payload["cases"]:
        anonymize.redact_text(
            payload["config_json"],
            item["text"],
            item.get("operators"),
        )
one_shot_ms = (time.perf_counter_ns() - one_shot_start) / 1_000_000
package_case_results = [
    result_to_dict(
        prepared.redact_text(
            item["text"],
            item.get("operators"),
        )
    )
    for item in payload["cases"]
]
one_shot_case_results = [
    result_to_dict(
        anonymize.redact_text(
            payload["config_json"],
            item["text"],
            item.get("operators"),
        )
    )
    for item in payload["cases"]
]
print(
    json.dumps(
        {
            "packagePrepareMs": package_prepare_ms,
            "loadMs": load_ms,
            "runMs": run_ms,
            "oneShotMs": one_shot_ms,
            "packageCaseResults": package_case_results,
            "oneShotCaseResults": one_shot_case_results,
        }
    )
)
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
const pythonPackageDir = join(tempDir, "stella_anonymize");
mkdirSync(pythonPackageDir);
const pythonModulePath = join(pythonPackageDir, "_native.so");
copyFileSync(nativeLibraryPath("stella_anonymize_napi"), napiPath);
copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), pythonModulePath);
copyFileSync(
  join(
    ROOT_DIR,
    "crates",
    "anonymize-py",
    "python",
    "stella_anonymize",
    "__init__.py",
  ),
  join(pythonPackageDir, "__init__.py"),
);
copyFileSync(
  join(
    ROOT_DIR,
    "crates",
    "anonymize-py",
    "python",
    "stella_anonymize",
    "docx.py",
  ),
  join(pythonPackageDir, "docx.py"),
);
copyFileSync(
  join(
    ROOT_DIR,
    "crates",
    "anonymize-py",
    "python",
    "stella_anonymize",
    "__init__.pyi",
  ),
  join(pythonPackageDir, "__init__.pyi"),
);
copyFileSync(
  join(
    ROOT_DIR,
    "crates",
    "anonymize-py",
    "python",
    "stella_anonymize",
    "_native.pyi",
  ),
  join(pythonPackageDir, "_native.pyi"),
);
copyFileSync(
  join(
    ROOT_DIR,
    "crates",
    "anonymize-py",
    "python",
    "stella_anonymize",
    "py.typed",
  ),
  join(pythonPackageDir, "py.typed"),
);

const native = createRequire(import.meta.url)(napiPath);
for (const userDataScenario of USER_DATA_SCENARIOS) {
  runScenario(userDataScenario);
}

function runScenario(userDataScenario) {
  const userData = userDataScenarioData(userDataScenario);
  const configJson = buildConfigJson(userData);
  const cases = buildCases(userData);
  const summaryContext = {
    userDataScenario,
    configBytes: Buffer.byteLength(configJson, "utf8"),
    customDenyListCount: userData.customDenyListCount,
    customRegexCount: userData.customRegexCount,
  };
  const payload = {
    config_json: configJson,
    iterations: ITERATIONS,
    top_level_iterations: TOP_LEVEL_ITERATIONS,
    cases: cases.map(({ text, operatorsConfig, operatorsJson }) => ({
      text,
      operators: operatorsConfig?.operators ?? null,
      operators_json: operatorsJson,
    })),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadPath = join(
    tempDir,
    `native-adapter-perf-${userDataScenario}.json`,
  );
  writeFileSync(payloadPath, payloadJson);
  const rustCoreResults = callRustCoreResults(payload, tempDir);

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
      STELLA_ANONYMIZE_PERF_PAYLOAD_PATH: payloadPath,
    },
  );
  const rustSummary = JSON.parse(rustOutput);
  printSummary({
    adapter: "rust-core",
    summary: rustSummary,
    fixtureCount: cases.length,
    iterations: ITERATIONS,
    context: summaryContext,
  });

  const tsPrepareStart = Bun.nanoseconds();
  const prepared = new native.NativePreparedSearch(configJson);
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
  assertAdapterResults(
    "ts-napi",
    cases.map((item) =>
      canonicalResult(
        prepared.redactStaticEntities(
          item.text,
          item.operatorsJson === undefined
            ? undefined
            : JSON.parse(item.operatorsJson),
        ),
      ),
    ),
    rustCoreResults,
  );
  printSummary({
    adapter: "ts-napi",
    summary: { prepareMs: tsPrepareMs, runMs: tsRunMs },
    fixtureCount: cases.length,
    iterations: ITERATIONS,
    context: summaryContext,
  });

  const packageStart = Bun.nanoseconds();
  const packageBytes = prepare_search_package({
    binding: native,
    config: configJson,
  });
  const packagePrepareMs = elapsedMs(packageStart);
  const loadStart = Bun.nanoseconds();
  const preparedSdk = load_prepared_package({
    binding: native,
    packageBytes,
  });
  const loadMs = elapsedMs(loadStart);
  const sdkRunStart = Bun.nanoseconds();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (const item of cases) {
      preparedSdk.redact_text(item.text, item.operatorsConfig);
    }
  }
  const sdkRunMs = elapsedMs(sdkRunStart);
  assertAdapterResults(
    "ts-sdk-prepared-package",
    cases.map((item) =>
      canonicalResult(preparedSdk.redact_text(item.text, item.operatorsConfig)),
    ),
    rustCoreResults,
  );
  printSummary({
    adapter: "ts-sdk-prepared-package",
    summary: {
      prepareMs: packagePrepareMs + loadMs,
      packagePrepareMs,
      loadMs,
      runMs: sdkRunMs,
    },
    fixtureCount: cases.length,
    iterations: ITERATIONS,
    context: summaryContext,
  });

  const topLevelRunStart = Bun.nanoseconds();
  for (let iteration = 0; iteration < TOP_LEVEL_ITERATIONS; iteration += 1) {
    for (const item of cases) {
      redactTextWithSdk({
        binding: native,
        config: configJson,
        fullText: item.text,
        ...(item.operatorsConfig !== undefined
          ? { operators: item.operatorsConfig }
          : {}),
      });
    }
  }
  const topLevelRunMs = elapsedMs(topLevelRunStart);
  assertAdapterResults(
    "ts-sdk-one-shot",
    cases.map((item) =>
      canonicalResult(
        redactTextWithSdk({
          binding: native,
          config: configJson,
          fullText: item.text,
          ...(item.operatorsConfig !== undefined
            ? { operators: item.operatorsConfig }
            : {}),
        }),
      ),
    ),
    rustCoreResults,
  );
  printSummary({
    adapter: "ts-sdk-one-shot",
    summary: { prepareMs: 0, runMs: topLevelRunMs },
    fixtureCount: cases.length,
    iterations: TOP_LEVEL_ITERATIONS,
    context: summaryContext,
  });

  const pyOutput = runCommand("python3", ["-c", pythonScript], {
    STELLA_ANONYMIZE_PERF_PAYLOAD_PATH: payloadPath,
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  });
  const pySummary = JSON.parse(pyOutput);
  assertAdapterResults("python-pyo3", pySummary.caseResults, rustCoreResults);
  printSummary({
    adapter: "python-pyo3",
    summary: pySummary,
    fixtureCount: cases.length,
    iterations: ITERATIONS,
    context: summaryContext,
  });

  const pySdkOutput = runCommand("python3", ["-c", pythonSdkScript], {
    STELLA_ANONYMIZE_PERF_PAYLOAD_PATH: payloadPath,
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  });
  const pySdkSummary = JSON.parse(pySdkOutput);
  assertAdapterResults(
    "python-sdk-prepared-package",
    pySdkSummary.packageCaseResults,
    rustCoreResults,
  );
  printSummary({
    adapter: "python-sdk-prepared-package",
    summary: {
      prepareMs: pySdkSummary.packagePrepareMs + pySdkSummary.loadMs,
      packagePrepareMs: pySdkSummary.packagePrepareMs,
      loadMs: pySdkSummary.loadMs,
      runMs: pySdkSummary.runMs,
    },
    fixtureCount: cases.length,
    iterations: ITERATIONS,
    context: summaryContext,
  });
  assertAdapterResults(
    "python-sdk-one-shot",
    pySdkSummary.oneShotCaseResults,
    rustCoreResults,
  );
  printSummary({
    adapter: "python-sdk-one-shot",
    summary: { prepareMs: 0, runMs: pySdkSummary.oneShotMs },
    fixtureCount: cases.length,
    iterations: TOP_LEVEL_ITERATIONS,
    context: summaryContext,
  });
}

function buildConfigJson(userData) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  const denyListSlice = config.slices.deny_list;
  const gazetteerSlice = config.slices.gazetteer;
  const countriesSlice = config.slices.countries;
  const denyListPatterns = config.literal_patterns.slice(
    denyListSlice.start,
    denyListSlice.end,
  );
  const gazetteerPatterns = config.literal_patterns.slice(
    gazetteerSlice.start,
    gazetteerSlice.end,
  );
  const countryPatterns = config.literal_patterns.slice(
    countriesSlice.start,
    countriesSlice.end,
  );
  const customDenyListPatterns = userData.denyListEntries.map(({ value }) =>
    literalPattern(value),
  );

  config.literal_patterns = [
    ...denyListPatterns,
    ...customDenyListPatterns,
    ...gazetteerPatterns,
    ...countryPatterns,
  ];
  config.slices.deny_list = {
    start: 0,
    end: denyListPatterns.length + customDenyListPatterns.length,
  };
  config.slices.gazetteer = {
    start: config.slices.deny_list.end,
    end: config.slices.deny_list.end + gazetteerPatterns.length,
  };
  config.slices.countries = {
    start: config.slices.gazetteer.end,
    end: config.slices.gazetteer.end + countryPatterns.length,
  };

  for (const entry of userData.denyListEntries) {
    config.deny_list_data.labels.push([entry.label]);
    config.deny_list_data.custom_labels.push([entry.label]);
    config.deny_list_data.originals.push(entry.value);
    config.deny_list_data.sources.push(["custom-deny-list"]);
  }
  for (const entry of userData.regexEntries) {
    config.custom_regex_patterns.push({
      kind: "regex",
      pattern: entry.pattern,
    });
    config.custom_regex_meta.push({
      label: entry.label,
      score: entry.score,
      source_detail: "custom-regex",
    });
  }
  config.slices.custom_regex = {
    start: 0,
    end: config.custom_regex_patterns.length,
  };

  return JSON.stringify(config);
}

function literalPattern(pattern) {
  return {
    kind: "literal-with-options",
    pattern,
    case_insensitive: true,
    whole_words: true,
  };
}

function userDataScenarioData(userDataScenario) {
  switch (userDataScenario) {
    case "none":
      return {
        customDenyListCount: 0,
        customRegexCount: 0,
        denyListEntries: [],
        regexEntries: [],
      };
    case "sample":
      return generatedUserData({
        customDenyListCount: 50,
        customRegexCount: 5,
      });
    case "heavy":
      return generatedUserData({
        customDenyListCount: 5_000,
        customRegexCount: 50,
      });
    default:
      throw new Error(`Unsupported user data scenario: ${userDataScenario}`);
  }
}

function generatedUserData({ customDenyListCount, customRegexCount }) {
  return {
    customDenyListCount,
    customRegexCount,
    denyListEntries: Array.from(
      { length: customDenyListCount },
      (_, index) => ({
        value: generatedCustomDenyListTerm(index),
        label: index % 2 === 0 ? "organization" : "person",
      }),
    ),
    regexEntries: Array.from({ length: customRegexCount }, (_, index) => ({
      pattern: generatedCustomRegexPattern(index),
      label:
        index % 2 === 0 ? "registration number" : "tax identification number",
      score: 0.92,
    })),
  };
}

function generatedCustomDenyListTerm(index) {
  return `CustomerPrivateTerm${String(index).padStart(5, "0")}`;
}

function generatedCustomRegexPattern(index) {
  return `USR-${String(index).padStart(4, "0")}-[A-Z]{2}\\d{4}`;
}

function generatedCustomRegexValue(index, caseIndex) {
  return `USR-${String(index).padStart(4, "0")}-AB${String(caseIndex).padStart(
    4,
    "0",
  )}`;
}

function userDataScenarios() {
  const value =
    process.env.ANONYMIZE_NATIVE_PERF_USER_DATA_SCENARIOS ??
    "none,sample,heavy";
  return value
    .split(",")
    .map((entry) => normalizeUserDataScenario(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function normalizeUserDataScenario(value) {
  const scenario = value.trim().toLowerCase();
  if (scenario === "none" || scenario === "sample" || scenario === "heavy") {
    return scenario;
  }
  throw new Error(
    `ANONYMIZE_NATIVE_PERF_USER_DATA_SCENARIOS must contain none, sample, or heavy; got ${value}`,
  );
}

function buildCases(userData) {
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
    const operatorsJson = operators[index % operators.length];
    const customText =
      userData.customDenyListCount === 0 || userData.customRegexCount === 0
        ? ""
        : ` Customer ${generatedCustomDenyListTerm(
            index % userData.customDenyListCount,
          )} references ${generatedCustomRegexValue(
            index % userData.customRegexCount,
            index,
          )}.`;
    fixtureCases.push({
      text:
        `Reference ${registration} for Acme s.r.o. near ` +
        `${place}, Turkey, Prague, matter ${matter}, code Secret Code.` +
        customText,
      operatorsConfig:
        operatorsJson === undefined ? undefined : JSON.parse(operatorsJson),
      operatorsJson,
    });
  }

  return fixtureCases;
}

function callRustCoreResults(perfPayload, tempDirectory) {
  const parityPayloadPath = join(tempDirectory, "native-adapter-parity.json");
  writeFileSync(
    parityPayloadPath,
    JSON.stringify({
      config_json: perfPayload.config_json,
      cases: perfPayload.cases.map(({ text, operators_json }) => ({
        text,
        operators_json,
      })),
    }),
  );
  const output = runCommand(
    "cargo",
    [
      "run",
      "-p",
      "stella-anonymize-adapter-contract",
      "--example",
      "native_adapter_parity",
      "--release",
      "--locked",
      "--quiet",
    ],
    {
      STELLA_ANONYMIZE_PARITY_PAYLOAD: parityPayloadPath,
    },
  );
  return JSON.parse(output).map(canonicalResult);
}

function assertAdapterResults(adapter, actualResults, expectedResults) {
  if (actualResults.length !== expectedResults.length) {
    throw new Error(
      `${adapter} returned ${actualResults.length} parity results, expected ${expectedResults.length}`,
    );
  }

  for (let index = 0; index < expectedResults.length; index += 1) {
    const actual = canonicalResult(actualResults[index]);
    const expected = expectedResults[index];
    const actualSignature = resultSignature(actual);
    const expectedSignature = resultSignature(expected);
    if (actualSignature === expectedSignature) {
      continue;
    }
    throw new Error(
      [
        `${adapter} parity mismatch at case ${index}`,
        `expected=${hashSignature(expectedSignature)}`,
        `actual=${hashSignature(actualSignature)}`,
      ].join(" "),
    );
  }
}

function canonicalResult(result) {
  const redaction = result.redaction;
  return {
    resolved_entities: readArray(
      result,
      "resolvedEntities",
      "resolved_entities",
    ).map(canonicalEntity),
    redaction: {
      redacted_text: readValue(redaction, "redactedText", "redacted_text"),
      redaction_map: canonicalRedactionEntries(
        readValue(redaction, "redactionMap", "redaction_map"),
      ),
      operator_map: canonicalOperatorEntries(
        readValue(redaction, "operatorMap", "operator_map"),
      ),
      entity_count: readValue(redaction, "entityCount", "entity_count"),
    },
  };
}

function canonicalEntity(entity) {
  return {
    start: entity.start,
    end: entity.end,
    label: entity.label,
    text: entity.text,
    score: entity.score,
    source: entity.source,
    source_detail:
      readOptionalValue(entity, "sourceDetail", "source_detail") ?? null,
  };
}

function canonicalRedactionEntries(entries) {
  if (entries instanceof Map) {
    return [...entries.entries()].map(([placeholder, original]) => ({
      placeholder,
      original,
    }));
  }
  return entries.map(({ placeholder, original }) => ({
    placeholder,
    original,
  }));
}

function canonicalOperatorEntries(entries) {
  if (entries instanceof Map) {
    return [...entries.entries()].map(([placeholder, operator]) => ({
      placeholder,
      operator,
    }));
  }
  return entries.map(({ placeholder, operator }) => ({
    placeholder,
    operator,
  }));
}

function readArray(value, camelKey, snakeKey) {
  const result = readValue(value, camelKey, snakeKey);
  if (!Array.isArray(result)) {
    throw new TypeError(`Expected array field ${camelKey}/${snakeKey}`);
  }
  return result;
}

function readValue(value, camelKey, snakeKey) {
  if (Object.hasOwn(value, camelKey)) {
    return value[camelKey];
  }
  if (Object.hasOwn(value, snakeKey)) {
    return value[snakeKey];
  }
  throw new TypeError(`Missing field ${camelKey}/${snakeKey}`);
}

function readOptionalValue(value, camelKey, snakeKey) {
  if (Object.hasOwn(value, camelKey)) {
    return value[camelKey];
  }
  if (Object.hasOwn(value, snakeKey)) {
    return value[snakeKey];
  }
  return undefined;
}

function resultSignature(result) {
  return JSON.stringify(result);
}

function hashSignature(signature) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
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

function printSummary({ adapter, summary, fixtureCount, iterations, context }) {
  const calls = fixtureCount * iterations;
  const runMs = Number(summary.runMs);
  const prepareMs = Number(summary.prepareMs);
  console.log(
    JSON.stringify({
      event: "native-adapter-perf",
      adapter,
      userDataScenario: context.userDataScenario,
      configBytes: context.configBytes,
      customDenyListCount: context.customDenyListCount,
      customRegexCount: context.customRegexCount,
      fixtureCount,
      iterations,
      calls,
      prepareMs: roundMs(prepareMs),
      runMs: roundMs(runMs),
      totalMs: roundMs(prepareMs + runMs),
      avgCallMs: roundMs(runMs / calls),
      ...extraSummaryFields(summary),
    }),
  );
}

function elapsedMs(start) {
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function roundMs(ms) {
  return Math.round(ms * 1_000) / 1_000;
}

function extraSummaryFields(summary) {
  const fields = {};
  for (const key of ["packagePrepareMs", "loadMs"]) {
    if (summary[key] !== undefined) {
      fields[key] = roundMs(Number(summary[key]));
    }
  }
  return fields;
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
      result.error === undefined ? "" : String(result.error),
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
