import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";
import {
  assertNativeBindingVersion,
  createNativeAnonymizerFromPackage,
  getNativeBindingVersion,
  prepareNativeSearchPackage,
  type NativeAnonymizeBinding,
  type NativeOperatorConfig,
  type NativePreparedSearchBinding,
  type NativeStaticRedactionResult,
} from "../native";
import { createPipelineContext, preparePipelineSearch } from "../index";
import { applyPipelineLanguageScope } from "../language-scope";
import { contractTestConfig } from "./contract-config";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(120_000);

type NativeAdapter = Omit<
  NativeAnonymizeBinding,
  | "prepareStaticSearchPackageBytes"
  | "prepareStaticSearchCompressedPackageBytes"
> & {
  normalizeForSearch: (text: string) => string;
  nativePackageVersion: () => string;
  NativePreparedSearch: NativeAnonymizeBinding["NativePreparedSearch"] & {
    new (configJson: string): NativePreparedSearchBinding;
    fromConfigJsonAndArtifactBytes: (
      configJson: Buffer,
      artifactBytes: Buffer,
    ) => NativePreparedSearchBinding;
  };
  prepareStaticSearchArtifactsBytes: (configJson: Buffer) => Buffer;
  prepareStaticSearchPackageBytes: (configJson: Uint8Array) => Buffer;
  prepareStaticSearchCompressedPackageBytes: (configJson: Uint8Array) => Buffer;
  redactStaticEntitiesJson: (
    configJson: string,
    fullText: string,
    operatorsJson?: string,
  ) => string;
  redactStaticEntitiesDiagnosticsJson: (
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
      operator: "replace" | "redact";
    }>;
    entity_count: number;
  };
};

type StaticRedactionDiagnosticResult = {
  result: StaticRedactionResult;
  diagnostics: {
    events: Array<{
      stage: string;
      kind: string;
      count?: number;
      engine?: string;
      pattern?: number;
      source?: string;
      source_detail?: string;
      label?: string;
      start?: number;
      end?: number;
      text?: string;
      score?: number;
      span_valid?: boolean;
      elapsed_us?: number;
      input_bytes?: number;
      reason?: string;
    }>;
  };
};

type GeneratedNativeCase = {
  text: string;
  operators: Record<string, string> | null;
  sensitiveValues: string[];
};

type ContractFixtureCase = {
  name: string;
  text: string;
};

type PythonNativeOffsetSlice = {
  start: number;
  end: number;
  slice: string;
  text: string;
};

const ROOT_DIR = join(import.meta.dir, "..", "..", "..", "..");
const TARGET_DIR = join(ROOT_DIR, "target", "debug");
const CONTRACT_FIXTURES_DIR = join(
  ROOT_DIR,
  "packages",
  "anonymize",
  "src",
  "__test__",
  "fixtures",
  "contracts",
);
const CONTRACT_FIXTURE_LANGUAGES = ["cs", "de", "en"] as const;
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
      document_heading_words: [],
      defined_term_cues: [],
    },
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

const PYTHON_NATIVE_OFFSET_SCRIPT = `
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
prepared = module.PreparedSearch(payload["config_json"])
result = prepared.redact_static_entities(
    payload["text"],
    payload.get("operators_json"),
)
entity = next(
    (
        item
        for item in result.resolved_entities
        if item.label == payload["label"]
    ),
    None,
)
if entity is None:
    raise AssertionError(f"entity not found: {payload['label']}")
sliced = payload["text"][entity.start:entity.end]
if sliced != payload["expected"]:
    raise AssertionError(
        f"slice mismatch: {sliced!r} at {entity.start}:{entity.end}"
    )
print(
    json.dumps(
        {
            "start": entity.start,
            "end": entity.end,
            "slice": sliced,
            "text": entity.text,
        }
    )
)
`;

const PYTHON_VERSION_SCRIPT = `
import importlib.util
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.native_package_version())
`;

const PYTHON_PREPARED_ARTIFACT_SCRIPT = `
import importlib.util
import json
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
artifact_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_ARTIFACTS"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
artifact_bytes = artifact_path.read_bytes()
if module.prepare_static_search_artifacts_bytes(payload["config_json"]) != artifact_bytes:
    raise AssertionError("prepared artifact bytes differ")
prepared = module.PreparedSearch.from_config_json_and_artifact_bytes(
    payload["config_json"],
    artifact_bytes,
)
print(
    prepared.redact_static_entities_json(
        payload["text"],
        payload.get("operators_json"),
    )
)
`;

const PYTHON_PREPARED_PACKAGE_SCRIPT = `
import importlib.util
import json
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
package_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PACKAGE"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
package_bytes = package_path.read_bytes()
prepare_fn_name = os.environ.get(
    "STELLA_ANONYMIZE_PACKAGE_PREPARE_FN",
    "prepare_static_search_package_bytes",
)
if getattr(module, prepare_fn_name)(payload["config_json"]) != package_bytes:
    raise AssertionError("prepared package bytes differ")
prepared = module.PreparedSearch.from_prepared_package_bytes(package_bytes)
print(
    prepared.redact_static_entities_json(
        payload["text"],
        payload.get("operators_json"),
    )
)
`;

const PYTHON_PREPARED_PACKAGE_CASES_SCRIPT = `
import importlib.util
import json
import os
import pathlib

module_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"])
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
package_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PACKAGE"])
spec = importlib.util.spec_from_file_location(
    "stella_anonymize_core_py",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
package_bytes = package_path.read_bytes()
prepare_fn_name = os.environ.get(
    "STELLA_ANONYMIZE_PACKAGE_PREPARE_FN",
    "prepare_static_search_package_bytes",
)
if getattr(module, prepare_fn_name)(payload["config_json"]) != package_bytes:
    raise AssertionError("prepared package bytes differ")
prepared = module.PreparedSearch.from_prepared_package_bytes(package_bytes)
results = [
    json.loads(
        prepared.redact_static_entities_json(
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
        `${fuzzyPlace}, Turkey, Prague, matter ${matter}, code Secret Code.` +
        `${middle}${right}`;
      return {
        text,
        operators,
        sensitiveValues: [
          registration,
          "Acme s.r.o.",
          fuzzyPlace,
          "Turkey",
          "Prague",
          matter,
          "Secret Code",
        ],
      };
    },
  );

describe("native adapter parity", () => {
  test("native adapter versions match package metadata", () => {
    const adapters = getAdapters();
    const packageVersion = packageJsonVersion();

    expect(getNativeBindingVersion(adapters.native)).toBe(packageVersion);
    expect(callPythonVersion(adapters.pythonModulePath)).toBe(packageVersion);
    expect(() =>
      assertNativeBindingVersion({
        binding: adapters.native,
        expectedVersion: packageVersion,
      }),
    ).not.toThrow();
    expect(() =>
      assertNativeBindingVersion({
        binding: adapters.native,
        expectedVersion: "0.0.0",
      }),
    ).toThrow();
  });

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
            expect(result?.redaction.entity_count).toBe(7);
            for (const value of item.sensitiveValues) {
              expect(result?.redaction.redacted_text).not.toContain(value);
            }
          }
        },
      ),
      { numRuns: 5, seed: 20_260_624 },
    );
  });

  test("adapter result offsets slice source text after multibyte prefixes", () => {
    const adapters = getAdapters();
    const text =
      "č Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";

    const tsResult = runTsAdapter(adapters.native, text, null);
    const pyResult = runPythonAdapters(
      adapters.pythonModulePath,
      [
        {
          text,
          operators: null,
          sensitiveValues: [],
        },
      ],
      adapters.tempDir,
    ).at(0);

    expect(pyResult).toEqual(tsResult);
    const registration = tsResult.resolved_entities.find(
      (entity) => entity.label === "registration number",
    );
    expect(registration).toBeDefined();
    if (!registration) {
      return;
    }
    expect(text.slice(registration.start, registration.end)).toBe("AB1234");
  });

  test("Python-native offsets slice source text after astral prefixes", () => {
    const adapters = getAdapters();
    const text = "🙂 Reference AB1234 for Acme s.r.o.";

    const tsResult = runTsAdapter(adapters.native, text, null);
    const registration = tsResult.resolved_entities.find(
      (entity) => entity.label === "registration number",
    );
    expect(registration).toBeDefined();
    if (!registration) {
      return;
    }
    expect(text.slice(registration.start, registration.end)).toBe("AB1234");

    const pythonSlice = callPythonNativeOffsetSlice(
      adapters.pythonModulePath,
      text,
      "registration number",
      "AB1234",
      null,
    );

    expect(pythonSlice).toEqual({
      start: 12,
      end: 18,
      slice: "AB1234",
      text: "AB1234",
    });
    expect(pythonSlice.start).toBe(registration.start - 1);
    expect(pythonSlice.end).toBe(registration.end - 1);
  });

  test("prepared search accepts config JSON bytes", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";

    const stringPrepared = new adapters.native.NativePreparedSearch(
      CONFIG_JSON,
    );
    const bytesPrepared =
      adapters.native.NativePreparedSearch.fromConfigJsonBytes(
        Buffer.from(CONFIG_JSON),
      );

    expect(bytesPrepared.redactStaticEntities(text)).toEqual(
      stringPrepared.redactStaticEntities(text),
    );
  });

  test("prepared search accepts artifact bytes through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const artifactBytes =
      adapters.native.prepareStaticSearchArtifactsBytes(configBytes);
    const direct = new adapters.native.NativePreparedSearch(CONFIG_JSON);
    const prepared =
      adapters.native.NativePreparedSearch.fromConfigJsonAndArtifactBytes(
        configBytes,
        artifactBytes,
      );

    expect(prepared.redactStaticEntities(text)).toEqual(
      direct.redactStaticEntities(text),
    );
    const expectedJson = JSON.parse(
      adapters.native.redactStaticEntitiesJson(CONFIG_JSON, text),
    );
    expect(
      callPythonPreparedWithArtifacts(
        adapters.pythonModulePath,
        adapters.tempDir,
        artifactBytes,
        text,
        null,
      ),
    ).toEqual(expectedJson);
  });

  test("prepared search accepts package bytes through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const packageBytes =
      adapters.native.prepareStaticSearchPackageBytes(configBytes);
    const direct = new adapters.native.NativePreparedSearch(CONFIG_JSON);
    const prepared =
      adapters.native.NativePreparedSearch.fromPreparedPackageBytes(
        packageBytes,
      );

    expect(prepared.redactStaticEntities(text)).toEqual(
      direct.redactStaticEntities(text),
    );
    const expectedJson = JSON.parse(
      adapters.native.redactStaticEntitiesJson(CONFIG_JSON, text),
    );
    expect(
      callPythonPreparedWithPackage(
        adapters.pythonModulePath,
        adapters.tempDir,
        packageBytes,
        text,
        null,
      ),
    ).toEqual(expectedJson);
  });

  test("prepared package cache verifies same-length corrupted bytes", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const packageBytes =
      adapters.native.prepareStaticSearchPackageBytes(configBytes);

    const prepared =
      adapters.native.NativePreparedSearch.fromPreparedPackageBytes(
        packageBytes,
      );
    expect(prepared.redactStaticEntities(text)).toBeDefined();

    const corrupted = Buffer.from(packageBytes);
    const lastIndex = corrupted.length - 1;
    const lastByte = corrupted.at(lastIndex);
    if (lastByte === undefined) {
      throw new Error("prepared package unexpectedly empty");
    }
    corrupted.writeUInt8(lastByte ^ 0x01, lastIndex);

    expect(() =>
      adapters.native.NativePreparedSearch.fromPreparedPackageBytes(corrupted),
    ).toThrow();
  });

  test("prepared search accepts compressed package bytes through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const packageBytes =
      adapters.native.prepareStaticSearchCompressedPackageBytes(configBytes);
    const direct = new adapters.native.NativePreparedSearch(CONFIG_JSON);
    const prepared =
      adapters.native.NativePreparedSearch.fromPreparedPackageBytes(
        packageBytes,
      );

    expect(prepared.redactStaticEntities(text)).toEqual(
      direct.redactStaticEntities(text),
    );
    const expectedJson = JSON.parse(
      adapters.native.redactStaticEntitiesJson(CONFIG_JSON, text),
    );
    expect(
      callPythonPreparedWithPackage(
        adapters.pythonModulePath,
        adapters.tempDir,
        packageBytes,
        text,
        null,
        "prepare_static_search_compressed_package_bytes",
      ),
    ).toEqual(expectedJson);
  });

  test("native facade redacts from compressed package bytes", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const operators: NativeOperatorConfig = {
      operators: { country: "redact" },
      redactString: "***",
    };
    const packageBytes = prepareNativeSearchPackage({
      binding: adapters.native,
      config: JSON.parse(CONFIG_JSON),
      compressed: true,
    });
    const anonymizer = createNativeAnonymizerFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const expected: StaticRedactionResult = JSON.parse(
      adapters.native.redactStaticEntitiesJson(
        CONFIG_JSON,
        text,
        JSON.stringify(operators),
      ),
    );

    const result = anonymizer.redactStaticEntities(text, operators);

    expect(result.resolvedEntities).toEqual(
      expected.resolved_entities.map(toNativeFacadeEntity),
    );
    expect(result.redaction.redactedText).toBe(
      expected.redaction.redacted_text,
    );
    expect(result.redaction.entityCount).toBe(expected.redaction.entity_count);
    expect([...result.redaction.redactionMap.entries()]).toEqual(
      expected.redaction.redaction_map.map(({ placeholder, original }) => [
        placeholder,
        original,
      ]),
    );
    expect([...result.redaction.operatorMap.entries()]).toEqual(
      expected.redaction.operator_map.map(({ placeholder, operator }) => [
        placeholder,
        operator,
      ]),
    );
    expect(result.redaction.redactedText).toContain("***");
  });

  test("native facade and Python match on contract fixture packages", async () => {
    const adapters = getAdapters();
    for (const language of CONTRACT_FIXTURE_LANGUAGES) {
      const fixtures = loadContractFixtureCases(language);
      const scopedConfig = applyPipelineLanguageScope({
        ...contractTestConfig(`native-facade-fixture-parity-${language}`),
        language,
      });
      const dictionaryScope: Parameters<typeof loadTestDictionaries>[0] = {};
      if (scopedConfig.denyListCountries !== undefined) {
        dictionaryScope.denyListCountries = scopedConfig.denyListCountries;
      }
      if (scopedConfig.nameCorpusLanguages !== undefined) {
        dictionaryScope.nameCorpusLanguages = scopedConfig.nameCorpusLanguages;
      }
      const dictionaries = await loadTestDictionaries(dictionaryScope);
      const search = await preparePipelineSearch({
        config: {
          ...scopedConfig,
          dictionaries,
        },
        context: createPipelineContext(),
      });
      const configJson = JSON.stringify(search.nativeStaticConfig);
      const packageBytes = prepareNativeSearchPackage({
        binding: adapters.native,
        config: search.nativeStaticConfig,
        compressed: true,
      });
      const anonymizer = createNativeAnonymizerFromPackage({
        binding: adapters.native,
        packageBytes,
      });

      const tsResults = fixtures.map(({ text }) =>
        toBindingStaticResult(anonymizer.redactStaticEntities(text)),
      );
      const pyResults = callPythonPreparedPackageCases(
        adapters.pythonModulePath,
        adapters.tempDir,
        Buffer.from(packageBytes),
        fixtures.map(({ text }) => ({ text, operators: null })),
        "prepare_static_search_compressed_package_bytes",
        configJson,
      );

      for (const [index, fixture] of fixtures.entries()) {
        expect({
          fixture: `${language}/${fixture.name}`,
          result: pyResults.at(index),
        }).toEqual({
          fixture: `${language}/${fixture.name}`,
          result: tsResults.at(index),
        });
      }
    }
  });

  test("JSON operator config accepts camel-case redactString", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";

    const result = JSON.parse(
      adapters.native.redactStaticEntitiesJson(
        CONFIG_JSON,
        text,
        JSON.stringify({
          operators: { country: "redact" },
          redactString: "***",
        }),
      ),
    ) as StaticRedactionResult;

    expect(result.redaction.redacted_text).toContain("***");
  });

  test("diagnostics JSON is identical through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const operators = { country: "redact" };

    const tsResult = runTsDiagnosticsAdapter(adapters.native, text, operators);
    const pyResult = callPythonDiagnostics(
      adapters.pythonModulePath,
      text,
      operators,
    );

    expect(stripDiagnosticTimings(pyResult)).toEqual(
      stripDiagnosticTimings(tsResult),
    );
    expect(
      tsResult.diagnostics.events.some(
        (event) =>
          event.kind === "stage-summary" &&
          typeof event.elapsed_us === "number",
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.some(
        (event) =>
          event.stage === "search.literal" &&
          event.kind === "stage-summary" &&
          typeof event.count === "number" &&
          event.count > 0,
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.some(
        (event) =>
          event.stage === "resolution.sanitize" &&
          event.kind === "entity" &&
          event.span_valid === true,
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.every((event) => event.text === undefined),
    ).toBe(true);
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
  const NativePreparedSearch = Reflect.get(
    Object(loaded),
    "NativePreparedSearch",
  );
  const nativePackageVersion = Reflect.get(
    Object(loaded),
    "nativePackageVersion",
  );
  const redactStaticEntitiesJson = Reflect.get(
    Object(loaded),
    "redactStaticEntitiesJson",
  );
  const redactStaticEntitiesDiagnosticsJson = Reflect.get(
    Object(loaded),
    "redactStaticEntitiesDiagnosticsJson",
  );
  const prepareStaticSearchArtifactsBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchArtifactsBytes",
  );
  const prepareStaticSearchPackageBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchPackageBytes",
  );
  const prepareStaticSearchCompressedPackageBytes = Reflect.get(
    Object(loaded),
    "prepareStaticSearchCompressedPackageBytes",
  );
  if (
    typeof NativePreparedSearch !== "function" ||
    typeof normalizeForSearch !== "function" ||
    typeof nativePackageVersion !== "function" ||
    typeof prepareStaticSearchArtifactsBytes !== "function" ||
    typeof prepareStaticSearchPackageBytes !== "function" ||
    typeof prepareStaticSearchCompressedPackageBytes !== "function" ||
    typeof redactStaticEntitiesJson !== "function" ||
    typeof redactStaticEntitiesDiagnosticsJson !== "function"
  ) {
    throw new TypeError("Native anonymize adapter exports are incomplete");
  }
  return {
    NativePreparedSearch:
      NativePreparedSearch as NativeAdapter["NativePreparedSearch"],
    normalizeForSearch,
    nativePackageVersion,
    prepareStaticSearchArtifactsBytes,
    prepareStaticSearchPackageBytes,
    prepareStaticSearchCompressedPackageBytes,
    redactStaticEntitiesJson,
    redactStaticEntitiesDiagnosticsJson,
  };
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

const runTsDiagnosticsAdapter = (
  adapter: NativeAdapter,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionDiagnosticResult => {
  const operatorsJson = operatorConfigJson(operators);
  return JSON.parse(
    adapter.redactStaticEntitiesDiagnosticsJson(
      CONFIG_JSON,
      text,
      operatorsJson,
    ),
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

const callPythonNativeOffsetSlice = (
  pythonModulePath: string,
  text: string,
  label: string,
  expected: string,
  operators: Record<string, string> | null,
): PythonNativeOffsetSlice => {
  const payloadDir = mkdtempSync(
    join(tmpdir(), "stella-anonymize-py-offsets-"),
  );
  const payloadPath = join(payloadDir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      text,
      label,
      expected,
      operators_json: operatorConfigJson(operators),
    }),
  );
  try {
    const output = runCommand("python3", ["-c", PYTHON_NATIVE_OFFSET_SCRIPT], {
      STELLA_ANONYMIZE_PAYLOAD: payloadPath,
      STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
    });
    return JSON.parse(output);
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
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

const callPythonVersion = (pythonModulePath: string): string =>
  runCommand("python3", ["-c", PYTHON_VERSION_SCRIPT], {
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  }).trimEnd();

const callPythonPreparedWithArtifacts = (
  pythonModulePath: string,
  tempDir: string,
  artifactBytes: Buffer,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionResult => {
  const payloadPath = join(tempDir, "prepared-artifacts-payload.json");
  const artifactPath = join(tempDir, "prepared-artifacts.bin");
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      text,
      operators_json: operatorConfigJson(operators),
    }),
  );
  const output = runCommand(
    "python3",
    ["-c", PYTHON_PREPARED_ARTIFACT_SCRIPT],
    {
      STELLA_ANONYMIZE_ARTIFACTS: artifactPath,
      STELLA_ANONYMIZE_PAYLOAD: payloadPath,
      STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
    },
  );
  return JSON.parse(output);
};

const callPythonPreparedWithPackage = (
  pythonModulePath: string,
  tempDir: string,
  packageBytes: Buffer,
  text: string,
  operators: Record<string, string> | null,
  prepareFn = "prepare_static_search_package_bytes",
  configJson = CONFIG_JSON,
): StaticRedactionResult => {
  const payloadPath = join(tempDir, "prepared-package-payload.json");
  const packagePath = join(tempDir, "prepared-package.bin");
  writeFileSync(packagePath, packageBytes);
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: configJson,
      text,
      operators_json: operatorConfigJson(operators),
    }),
  );
  const output = runCommand("python3", ["-c", PYTHON_PREPARED_PACKAGE_SCRIPT], {
    STELLA_ANONYMIZE_PACKAGE: packagePath,
    STELLA_ANONYMIZE_PACKAGE_PREPARE_FN: prepareFn,
    STELLA_ANONYMIZE_PAYLOAD: payloadPath,
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  });
  return JSON.parse(output);
};

const callPythonPreparedPackageCases = (
  pythonModulePath: string,
  tempDir: string,
  packageBytes: Buffer,
  cases: Array<{
    text: string;
    operators: Record<string, string> | null;
  }>,
  prepareFn = "prepare_static_search_package_bytes",
  configJson = CONFIG_JSON,
): StaticRedactionResult[] => {
  const payloadPath = join(tempDir, "prepared-package-cases-payload.json");
  const packagePath = join(tempDir, "prepared-package-cases.bin");
  writeFileSync(packagePath, packageBytes);
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: configJson,
      cases: cases.map(({ text, operators }) => ({
        text,
        operators_json: operatorConfigJson(operators),
      })),
    }),
  );
  const output = runCommand(
    "python3",
    ["-c", PYTHON_PREPARED_PACKAGE_CASES_SCRIPT],
    {
      STELLA_ANONYMIZE_PACKAGE: packagePath,
      STELLA_ANONYMIZE_PACKAGE_PREPARE_FN: prepareFn,
      STELLA_ANONYMIZE_PAYLOAD: payloadPath,
      STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
    },
  );
  return JSON.parse(output);
};

const callPythonDiagnostics = (
  pythonModulePath: string,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionDiagnosticResult => {
  const payloadDir = mkdtempSync(
    join(tmpdir(), "stella-anonymize-diagnostics-"),
  );
  const payloadPath = join(payloadDir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      text,
      operators_json: operatorConfigJson(operators),
    }),
  );
  try {
    const output = runCommand(
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
print(
    module.redact_static_entities_diagnostics_json(
        payload["config_json"],
        payload["text"],
        payload.get("operators_json"),
    )
)
`,
      ],
      {
        STELLA_ANONYMIZE_PAYLOAD: payloadPath,
        STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
      },
    );
    return JSON.parse(output);
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
};

const stripDiagnosticTimings = (
  result: StaticRedactionDiagnosticResult,
): StaticRedactionDiagnosticResult => ({
  result: result.result,
  diagnostics: {
    events: result.diagnostics.events.map(
      ({ elapsed_us: _elapsedUs, ...event }) => event,
    ),
  },
});

const toNativeFacadeEntity = ({
  source_detail: sourceDetail,
  ...entity
}: StaticRedactionResult["resolved_entities"][number]) => ({
  ...entity,
  ...(sourceDetail ? { sourceDetail } : {}),
});

const toBindingStaticResult = (
  result: NativeStaticRedactionResult,
): StaticRedactionResult => ({
  resolved_entities: result.resolvedEntities.map(toBindingPipelineEntity),
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
});

const toBindingPipelineEntity = ({
  sourceDetail,
  ...entity
}: NativeStaticRedactionResult["resolvedEntities"][number]) => ({
  ...entity,
  source_detail: sourceDetail ?? null,
});

const loadContractFixtureCases = (
  language: (typeof CONTRACT_FIXTURE_LANGUAGES)[number],
): ContractFixtureCase[] =>
  readdirSync(join(CONTRACT_FIXTURES_DIR, language))
    .filter((name) => name.endsWith(".txt"))
    .toSorted()
    .map((name) => ({
      name,
      text: readFileSync(join(CONTRACT_FIXTURES_DIR, language, name), "utf8"),
    }));

const packageJsonVersion = (): string => {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT_DIR, "packages", "anonymize", "package.json"), {
      encoding: "utf8",
    }),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new TypeError("Package version is missing");
  }
  return packageJson.version;
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
