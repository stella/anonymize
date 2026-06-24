import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";

setDefaultTimeout(120_000);

type NativeAdapter = {
  normalizeForSearch: (text: string) => string;
  redactStaticEntitiesJson: (
    configJson: string,
    fullText: string,
    operatorsJson?: string,
  ) => string;
};

type RedactionEntry = {
  placeholder: string;
  original: string;
};

type StaticRedactionResult = {
  resolved_entities: Array<{
    start: number;
    end: number;
    label: string;
    text: string;
    score: number;
    source: string;
    source_detail?: string | null;
  }>;
  redaction: {
    redacted_text: string;
    redaction_map: RedactionEntry[];
    operator_map: Array<{
      placeholder: string;
      operator: string;
    }>;
    entity_count: number;
  };
};

type GeneratedNativeCase = {
  text: string;
  operators: Record<string, string> | null;
  sensitiveValues: string[];
};

const ROOT_DIR = join(import.meta.dir, "..", "..", "..", "..");
const TARGET_DIR = join(ROOT_DIR, "target", "debug");
const CONFIG_JSON = JSON.stringify({
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
    deny_list: { start: 0, end: 1 },
    gazetteer: { start: 1, end: 3 },
    countries: { start: 3, end: 4 },
  },
  regex_meta: [{ label: "registration number", score: 0.9 }],
  custom_regex_meta: [
    { label: "matter id", score: 1, source_detail: "custom-regex" },
  ],
  deny_list_data: {
    labels: [["matter"]],
    custom_labels: [["matter"]],
    originals: ["Secret Code"],
    sources: [["custom-deny-list"]],
  },
  gazetteer_data: {
    labels: ["organization", "address"],
    is_fuzzy: [false, true],
  },
  country_data: { labels: ["country"] },
});

const PYTHON_ADAPTER_SCRIPT = `
import importlib.util
import json
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
results = [
    json.loads(
        module.redact_static_entities_json(
            payload["config_json"],
            item["text"],
            item.get("operators_json"),
        )
    )
    for item in payload["cases"]
]
print(json.dumps(results))
`;

let loadedAdapters: {
  native: NativeAdapter;
  pythonModulePath: string;
  tempDir: string;
} | null = null;

const gapArb = fc
  .array(
    fc.constantFrom(
      " ",
      "\t",
      "\n",
      ".",
      ",",
      ";",
      ":",
      "(",
      ")",
      "a",
      "e",
      "n",
      "r",
      "s",
      "t",
      "č",
      "ř",
      "á",
      "ü",
    ),
    { maxLength: 12 },
  )
  .map((chars) => chars.join(""));

const registrationArb = fc
  .record({
    prefix: fc.tuple(
      fc.constantFrom("A", "B", "C", "D", "E", "F"),
      fc.constantFrom("G", "H", "I", "J", "K", "L"),
    ),
    serial: fc.integer({ min: 0, max: 9999 }),
  })
  .map(
    ({ prefix, serial }) =>
      `${prefix.join("")}${String(serial).padStart(4, "0")}`,
  );

const matterArb = fc
  .integer({ min: 0, max: 999 })
  .map((value) => `MAT-${String(value).padStart(3, "0")}`);

const fuzzyPlaceArb = fc.constantFrom("Fuzztovn", "Fuzztawn", "Fuzztowm");

const operatorsArb = fc.option(
  fc.constantFrom(
    { country: "redact" },
    { address: "redact", country: "redact" },
    { "matter id": "redact" },
    { matter: "redact" },
  ),
  { nil: null },
);

const generatedCaseArb: fc.Arbitrary<GeneratedNativeCase> = fc
  .record({
    left: gapArb,
    middle: gapArb,
    right: gapArb,
    registration: registrationArb,
    matter: matterArb,
    fuzzyPlace: fuzzyPlaceArb,
    operators: operatorsArb,
  })
  .map(
    ({ left, middle, right, registration, matter, fuzzyPlace, operators }) => {
      const text =
        `${left}Reference ${registration} for Acme s.r.o. near ` +
        `${fuzzyPlace}, Turkey, matter ${matter}, code Secret Code.` +
        `${middle}${right}`;
      return {
        text,
        operators,
        sensitiveValues: [
          registration,
          "Acme s.r.o.",
          fuzzyPlace,
          "Turkey",
          matter,
          "Secret Code",
        ],
      };
    },
  );

describe("native adapter parity", () => {
  test("normalization is identical through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text = "Číslo\u00a0PAS - 1234 / Fuzztovn";

    expect(callPythonNormalize(adapters.pythonModulePath, text)).toBe(
      adapters.native.normalizeForSearch(text),
    );
  });

  test("generated static-redaction fixtures match exactly", () => {
    const adapters = getAdapters();

    fc.assert(
      fc.property(
        fc.array(generatedCaseArb, { minLength: 10, maxLength: 40 }),
        (cases) => {
          const tsResults = cases.map(({ text, operators }) =>
            runTsAdapter(adapters.native, text, operators),
          );
          const pyResults = runPythonAdapters(
            adapters.pythonModulePath,
            cases,
            adapters.tempDir,
          );

          expect(pyResults).toEqual(tsResults);
          for (const [index, item] of cases.entries()) {
            const result = tsResults.at(index);
            expect(result).toBeDefined();
            expect(result?.redaction.entity_count).toBe(6);
            for (const value of item.sensitiveValues) {
              expect(result?.redaction.redacted_text).not.toContain(value);
            }
          }
        },
      ),
      { numRuns: 5, seed: 20_260_624 },
    );
  });
});

const getAdapters = () => {
  if (loadedAdapters !== null) {
    return loadedAdapters;
  }

  runCommand("cargo", [
    "build",
    "-p",
    "stella-anonymize-napi",
    "-p",
    "stella-anonymize-py",
    "--locked",
  ]);

  const tempDir = mkdtempSync(join(tmpdir(), "stella-anonymize-native-"));
  const napiPath = join(tempDir, "stella_anonymize_napi.node");
  const pythonModulePath = join(tempDir, "stella_anonymize_core_py.so");
  copyFileSync(nativeLibraryPath("stella_anonymize_napi"), napiPath);
  copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), pythonModulePath);

  const native = loadNativeAdapter(napiPath);
  loadedAdapters = { native, pythonModulePath, tempDir };
  return loadedAdapters;
};

const nativeLibraryPath = (name: string): string => {
  if (process.platform === "darwin") {
    return join(TARGET_DIR, `lib${name}.dylib`);
  }
  if (process.platform === "linux") {
    return join(TARGET_DIR, `lib${name}.so`);
  }
  return join(TARGET_DIR, `${name}.dll`);
};

const loadNativeAdapter = (nativePath: string): NativeAdapter => {
  const nativeRequire = createRequire(import.meta.url);
  const loaded: unknown = nativeRequire(nativePath);
  const normalizeForSearch = Reflect.get(Object(loaded), "normalizeForSearch");
  const redactStaticEntitiesJson = Reflect.get(
    Object(loaded),
    "redactStaticEntitiesJson",
  );
  if (
    typeof normalizeForSearch !== "function" ||
    typeof redactStaticEntitiesJson !== "function"
  ) {
    throw new TypeError("Native anonymize adapter exports are incomplete");
  }
  return { normalizeForSearch, redactStaticEntitiesJson };
};

const runTsAdapter = (
  adapter: NativeAdapter,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionResult => {
  const operatorsJson = operatorConfigJson(operators);
  return JSON.parse(
    adapter.redactStaticEntitiesJson(CONFIG_JSON, text, operatorsJson),
  );
};

const runPythonAdapters = (
  pythonModulePath: string,
  cases: GeneratedNativeCase[],
  tempDir: string,
): StaticRedactionResult[] => {
  const payloadPath = join(tempDir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      cases: cases.map(({ text, operators }) => ({
        text,
        operators_json: operatorConfigJson(operators),
      })),
    }),
  );

  const output = runCommand("python3", ["-c", PYTHON_ADAPTER_SCRIPT], {
    STELLA_ANONYMIZE_PAYLOAD: payloadPath,
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  });
  return JSON.parse(output);
};

const callPythonNormalize = (
  pythonModulePath: string,
  text: string,
): string => {
  const payloadDir = mkdtempSync(join(tmpdir(), "stella-anonymize-normalize-"));
  const payloadPath = join(payloadDir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({ text }));
  try {
    return runCommand(
      "python3",
      [
        "-c",
        `
import importlib.util
import json
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
print(module.normalize_for_search(payload["text"]))
`,
      ],
      {
        STELLA_ANONYMIZE_PAYLOAD: payloadPath,
        STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
      },
    ).trimEnd();
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
};

const operatorConfigJson = (
  operators: Record<string, string> | null,
): string | undefined => {
  if (operators === null) {
    return undefined;
  }
  return JSON.stringify({ operators });
};

const runCommand = (
  command: string,
  args: string[],
  env: Record<string, string> = {},
): string => {
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
};
