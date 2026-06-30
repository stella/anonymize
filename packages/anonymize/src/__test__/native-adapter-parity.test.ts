import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
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
  diagnostics_json,
  diagnostics_stream_json,
  getNativeBindingVersion,
  load_prepared_package,
  native_package_version,
  normalize_for_search,
  prepareNativeSearchPackage,
  prepare_search_package,
  PreparedAnonymizer,
  PreparedSearch,
  redact_text,
  redact_text_json,
  summary_diagnostics_json,
  type NativeAnonymizeBinding,
  type NativeOperatorConfig,
  type NativePreparedSearchBinding,
  type NativeStaticRedactionResult,
} from "../native";
import type {
  Entity,
  OperatorConfig,
  PipelineConfig,
  RedactionResult,
} from "../types";
import {
  PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_NAMES,
  PYTHON_NATIVE_SDK_PUBLIC_TYPE_NAMES,
  SHARED_NATIVE_SDK_CLASS_NAMES,
  SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS,
  SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS,
  SHARED_NATIVE_SDK_PREPARED_METHODS,
  SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS,
} from "../native-sdk-contract";
import {
  getDefaultNativePipeline,
  preloadDefaultNativePipeline,
  redact_default_text,
  redact_default_text_json,
} from "../native-node";
import { buildNativeStaticSearchBundle } from "../build-unified-search";
import {
  createPipelineContext,
  createNativePipelineFromPackage,
  DEFAULT_ENTITY_LABELS,
  getNativePipelineCompatibility,
  prepareNativePipelinePackage,
  redactText,
  runPipeline,
} from "../index";
import { applyPipelineLanguageScope } from "../language-scope";
import { contractTestConfig } from "./contract-config";
import { loadTestDictionaries } from "./load-dictionaries";

setDefaultTimeout(240_000);

const SLOW_NATIVE_FIXTURE_PARITY_TIMEOUT_MS = 600_000;
const RUN_SLOW_NATIVE_FIXTURE_PARITY =
  process.env["ANONYMIZE_TEST_SLOW_NATIVE_FIXTURE_PARITY"] === "1";
const slowNativeFixtureParityTest = RUN_SLOW_NATIVE_FIXTURE_PARITY
  ? test
  : test.skip;

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
  redactStaticEntitiesSummaryDiagnosticsJson: (
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

type OffsetFreeStaticRedactionResult = {
  resolved_entities: Array<
    Omit<StaticRedactionResult["resolved_entities"][number], "start" | "end">
  >;
  redaction: StaticRedactionResult["redaction"];
};

type StaticRedactionDiagnosticResult = {
  result: StaticRedactionResult;
  diagnostics: {
    events: Array<{
      stage: string;
      kind: string;
      count?: number;
      slot?: number;
      subslot?: number;
      pattern_count?: number;
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
      artifact_count?: number;
      artifact_bytes?: number;
      reason?: string;
    }>;
  };
};

type GeneratedNativeCase = {
  text: string;
  operators: Record<string, string> | null;
  sensitiveValues: string[];
};

type SharedSdkParityCase = {
  text: string;
  operators: NativeOperatorConfig | null;
};

type ContractFixtureCase = {
  name: string;
  text: string;
};

type ExpectedNativeFixtureEntity = {
  label: string;
  source?: string;
  text: string;
};

type NativeFixtureImprovementCase = {
  language: (typeof CONTRACT_FIXTURE_LANGUAGES)[number];
  fixture: string;
  includes?: ExpectedNativeFixtureEntity[];
  excludes?: ExpectedNativeFixtureEntity[];
};

type PythonNativeOffsetSlice = {
  start: number;
  end: number;
  slice: string;
  text: string;
};

const ROOT_DIR = join(import.meta.dir, "..", "..", "..", "..");
const TARGET_DIR = join(ROOT_DIR, "target", "debug");
const PYTHON_SOURCE_DIR = join(ROOT_DIR, "crates", "anonymize-py", "python");
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
const NATIVE_FIXTURE_IMPROVEMENTS: NativeFixtureImprovementCase[] = [
  {
    language: "cs",
    fixture: "asset-transfer-court-declensions.txt",
    includes: [
      {
        label: "address",
        source: "regex",
        text: "Václavské náměstí 9, 110 00 Praha 1",
      },
    ],
  },
  {
    language: "cs",
    fixture: "nakit-legal-services-framework.txt",
    excludes: [{ label: "person", text: "Objednatele" }],
  },
  {
    language: "cs",
    fixture: "vinci-donation-agreement.txt",
    includes: [
      {
        label: "organization",
        source: "deny-list",
        text: "České vysoké učení technické v Praze",
      },
      {
        label: "organization",
        source: "coreference",
        text: "VINCI Construction CS",
      },
    ],
  },
  {
    language: "en",
    fixture: "software-license-agreement.txt",
    includes: [
      {
        label: "address",
        source: "regex",
        text: "200 West Street, New York, NY 10282",
      },
      {
        label: "address",
        source: "regex",
        text: "1209 Orange Street, Wilmington, DE 19801",
      },
      {
        label: "phone number",
        source: "regex",
        text: "(212) 555-0142",
      },
    ],
  },
];
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
      ambiguous_street_type_terms: [],
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
    "_native",
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
    "_native",
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
    "_native",
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
    "_native",
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
    "_native",
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
    "_native",
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

const PYTHON_PACKAGE_FACADE_SCRIPT = `
import json
import os
import pathlib
import sys

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
package_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PACKAGE"])
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

payload = json.loads(payload_path.read_text())
package_bytes = package_path.read_bytes()
if anonymize.prepare_search_package(
    payload["config_json"],
    compressed=payload["compressed"],
) != package_bytes:
    raise AssertionError("facade package bytes differ")
prepared = anonymize.load_prepared_package(package_bytes)
if prepared is not anonymize.load_prepared_package(package_bytes):
    raise AssertionError("facade package cache did not reuse prepared search")
from_file = anonymize.load_prepared_package_file(package_path)
print(
    json.dumps(
        {
            "from_bytes": json.loads(
                prepared.redact_static_entities_json(
                    payload["text"],
                    payload.get("operators_json"),
                )
            ),
            "from_file": json.loads(
                from_file.redact_static_entities_json(
                    payload["text"],
                    payload.get("operators_json"),
                )
            ),
            "available_languages": list(
                anonymize.available_default_native_pipeline_languages()
            ),
            "prepare_stages": [
                event.get("stage")
                for event in json.loads(prepared.prepare_diagnostics_json()).get(
                    "events",
                    [],
                )
            ],
            "module_version": anonymize.__version__,
            "version": anonymize.native_package_version(),
        }
    )
)
`;

const PYTHON_SHARED_SDK_PARITY_SCRIPT = `
import json
import os
import pathlib
import sys

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
package_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PACKAGE"])
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

payload = json.loads(payload_path.read_text())
package_bytes = package_path.read_bytes()
top_level = payload["top_level_functions"]
default_package_functions = payload["default_package_functions"]
default_package_names = payload["default_package_names"]
public_type_names = payload["public_type_names"]
prepared_methods = payload["prepared_methods"]
class_names = payload["class_names"]
missing_top_level = [
    name for name in top_level if not callable(getattr(anonymize, name, None))
]
if missing_top_level:
    raise AssertionError(f"missing Python SDK functions: {missing_top_level}")
missing_default_package = [
    name
    for name in default_package_functions
    if not callable(getattr(anonymize, name, None))
]
if missing_default_package:
    raise AssertionError(
        f"missing Python default package functions: {missing_default_package}"
    )
missing_public_names = [
    name
    for name in [
        *top_level,
        *default_package_functions,
        *default_package_names,
        *public_type_names,
        *class_names,
    ]
    if name not in anonymize.__all__
]
if missing_public_names:
    raise AssertionError(f"missing Python SDK public names: {missing_public_names}")
missing_default_package_names = [
    name
    for name in default_package_names
    if not hasattr(anonymize, name)
]
if missing_default_package_names:
    raise AssertionError(
        f"missing Python default package names: {missing_default_package_names}"
    )
if set(anonymize.DEFAULT_NATIVE_PIPELINE_WARMUPS) != {"lazy-regex", "none"}:
    raise AssertionError("unexpected Python default pipeline warmup modes")
if "__version__" not in anonymize.__all__:
    raise AssertionError("missing Python SDK version public name")
missing_classes = [
    name for name in class_names if not callable(getattr(anonymize, name, None))
]
if missing_classes:
    raise AssertionError(f"missing Python SDK classes: {missing_classes}")
prepared = anonymize.load_prepared_package(package_bytes)
if prepared is not anonymize.load_prepared_package(package_bytes):
    raise AssertionError("facade package cache did not reuse prepared search")
missing_prepared = [
    name for name in prepared_methods if not callable(getattr(prepared, name, None))
]
if missing_prepared:
    raise AssertionError(f"missing Python prepared methods: {missing_prepared}")
from_file = anonymize.load_prepared_package_file(package_path)
deferred_default_from_path = anonymize.get_default_native_pipeline(
    package_path=package_path,
    warmup="none",
)
if deferred_default_from_path is not anonymize.get_default_native_pipeline(
    package_path=package_path,
    warmup="none",
):
    raise AssertionError("default package path cache did not reuse prepared search")
default_from_path = anonymize.get_default_native_pipeline(package_path=package_path)
if default_from_path is not deferred_default_from_path:
    raise AssertionError("default package warmup changed prepared search cache key")
if anonymize.preload_default_native_pipeline(package_path=package_path) is not default_from_path:
    raise AssertionError("default package preload did not return cached prepared search")
try:
    anonymize.get_default_native_pipeline(package_path=package_path, warmup="eager")
except ValueError as error:
    if 'Default native pipeline warmup must be "lazy-regex" or "none"' not in str(error):
        raise
else:
    raise AssertionError("invalid Python default package warmup was accepted")
if anonymize.prepare_search_package(
    payload["config_json"],
    compressed=payload["compressed"],
) != package_bytes:
    raise AssertionError("facade package bytes differ")
if anonymize.prepare_search_package(
    payload["config_json"].encode("utf-8"),
    compressed=payload["compressed"],
) != package_bytes:
    raise AssertionError("facade package bytes differ for bytes config")
if anonymize.prepare_search_package(
    payload["config_object"],
    compressed=payload["compressed"],
) != package_bytes:
    raise AssertionError("facade package bytes differ for object config")

def redact_with(instance, item):
    return json.loads(
        instance.redact_text_json(
            item["text"],
            item.get("operators"),
            redact_string=item.get("redact_string"),
        )
    )

def redact_object_with_top_level(item):
    result = anonymize.redact_text(
        payload["config_json"],
        item["text"],
        item.get("operators"),
        redact_string=item.get("redact_string"),
    )
    return {
        "resolved_entities": [
            {
                "label": entity.label,
                "text": entity.text,
                "score": entity.score,
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

print(
    json.dumps(
        {
            "from_bytes": [
                redact_with(prepared, item) for item in payload["cases"]
            ],
            "from_file": [
                redact_with(from_file, item) for item in payload["cases"]
            ],
            "default_from_path": [
                redact_with(default_from_path, item) for item in payload["cases"]
            ],
            "top_level": [
                json.loads(
                    anonymize.redact_text_json(
                        payload["config_json"],
                        item["text"],
                        item.get("operators"),
                        redact_string=item.get("redact_string"),
                    )
                )
                for item in payload["cases"]
            ],
            "top_level_bytes": [
                json.loads(
                    anonymize.redact_text_json(
                        payload["config_json"].encode("utf-8"),
                        item["text"],
                        item.get("operators"),
                        redact_string=item.get("redact_string"),
                    )
                )
                for item in payload["cases"]
            ],
            "top_level_object_json": [
                json.loads(
                    anonymize.redact_text_json(
                        payload["config_object"],
                        item["text"],
                        item.get("operators"),
                        redact_string=item.get("redact_string"),
                    )
                )
                for item in payload["cases"]
            ],
            "top_level_object": [
                redact_object_with_top_level(item) for item in payload["cases"]
            ],
            "available_languages": list(
                anonymize.available_default_native_pipeline_languages()
            ),
            "normalized": anonymize.normalize_for_search(payload["normalize_text"]),
            "module_version": anonymize.__version__,
            "version": anonymize.native_package_version(),
        }
    )
)
`;

const PYTHON_DEFAULT_PACKAGE_PARITY_SCRIPT = `
import json
import os
import pathlib
import sys

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
payload_path = pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"])
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

payload = json.loads(payload_path.read_text())
pipeline = anonymize.get_default_native_pipeline(language=payload["language"])
preloaded = anonymize.preload_default_native_pipeline(language=payload["language"])
if preloaded is not pipeline:
    raise AssertionError("default package preload did not reuse cached pipeline")

def redact_default_object(item):
    result = anonymize.redact_default_text(
        item["text"],
        item.get("operators"),
        language=payload["language"],
    )
    return {
        "resolved_entities": [
            {
                "label": entity.label,
                "text": entity.text,
                "score": entity.score,
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

print(
    json.dumps(
        {
            "results": [
                json.loads(
                    pipeline.redact_text_json(
                        item["text"],
                        item.get("operators"),
                    )
                )
                for item in payload["cases"]
            ],
            "helper_results": [
                json.loads(
                    anonymize.redact_default_text_json(
                        item["text"],
                        item.get("operators"),
                        language=payload["language"],
                    )
                )
                for item in payload["cases"]
            ],
            "helper_object_results": [
                redact_default_object(item) for item in payload["cases"]
            ],
            "available_languages": list(
                anonymize.available_default_native_pipeline_languages()
            ),
            "module_version": anonymize.__version__,
            "version": anonymize.native_package_version(),
        }
    )
)
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
    const diagnosticsJson = prepared.prepareDiagnosticsJson?.();
    if (diagnosticsJson === undefined) {
      throw new Error("missing prepare diagnostics");
    }
    const diagnostics = JSON.parse(diagnosticsJson);

    expect(prepared.redactStaticEntities(text)).toEqual(
      direct.redactStaticEntities(text),
    );
    expect(
      diagnostics.events.some(
        (event: { stage?: unknown }) => event.stage === "prepare.cache.hit",
      ),
    ).toBe(true);
    const runDiagnosticsJson =
      prepared.redactStaticEntitiesDiagnosticsJson?.(text);
    if (runDiagnosticsJson === undefined) {
      throw new Error("missing prepared run diagnostics");
    }
    const runDiagnostics = JSON.parse(
      runDiagnosticsJson,
    ) as StaticRedactionDiagnosticResult;
    expect(
      runDiagnostics.diagnostics.events.some(
        (event) => event.stage === "prepare.cache.hit",
      ),
    ).toBe(true);
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

  test("trusted prepared package loading skips only package digest verification", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const packageBytes =
      adapters.native.prepareStaticSearchCompressedPackageBytes(configBytes);
    if (
      adapters.native.NativePreparedSearch.fromTrustedPreparedPackageBytes ===
      undefined
    ) {
      throw new Error("missing trusted prepared package factory");
    }

    const corruptedDigest = Buffer.from(packageBytes);
    const digestStart = 12;
    const digestByte = corruptedDigest.at(digestStart);
    if (digestByte === undefined) {
      throw new Error("prepared package header unexpectedly truncated");
    }
    corruptedDigest.writeUInt8(digestByte ^ 0x01, digestStart);

    expect(() =>
      adapters.native.NativePreparedSearch.fromPreparedPackageBytes(
        corruptedDigest,
      ),
    ).toThrow();

    const trusted =
      adapters.native.NativePreparedSearch.fromTrustedPreparedPackageBytes(
        corruptedDigest,
      );
    const diagnosticsJson = trusted.prepareDiagnosticsJson?.();
    if (diagnosticsJson === undefined) {
      throw new Error("missing trusted prepare diagnostics");
    }
    const diagnostics = JSON.parse(diagnosticsJson);

    expect(trusted.redactStaticEntities(text)).toEqual(
      new adapters.native.NativePreparedSearch(
        CONFIG_JSON,
      ).redactStaticEntities(text),
    );
    expect(
      diagnostics.events.some(
        (event: { stage?: unknown }) =>
          event.stage === "prepare.package.verify",
      ),
    ).toBe(false);
    expect(
      diagnostics.events.some(
        (event: { stage?: unknown }) =>
          event.stage === "prepare.package.decompress",
      ),
    ).toBe(true);

    const cached =
      adapters.native.NativePreparedSearch.fromTrustedPreparedPackageBytes(
        corruptedDigest,
      );
    const cachedDiagnosticsJson = cached.prepareDiagnosticsJson?.();
    if (cachedDiagnosticsJson === undefined) {
      throw new Error("missing cached trusted prepare diagnostics");
    }
    const cachedDiagnostics = JSON.parse(cachedDiagnosticsJson);

    expect(
      cachedDiagnostics.events.some(
        (event: { stage?: unknown }) => event.stage === "prepare.cache.hit",
      ),
    ).toBe(true);
    expect(
      cachedDiagnostics.events.some(
        (event: { stage?: unknown }) =>
          event.stage === "prepare.package.verify",
      ),
    ).toBe(false);
    expect(
      cachedDiagnostics.events.some(
        (event: { stage?: unknown }) =>
          event.stage === "prepare.package.decompress",
      ),
    ).toBe(false);
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
    const diagnosticsJson = prepared.prepareDiagnosticsJson?.();
    if (diagnosticsJson === undefined) {
      throw new Error("missing prepare diagnostics");
    }
    const diagnostics = JSON.parse(diagnosticsJson);

    expect(prepared.redactStaticEntities(text)).toEqual(
      direct.redactStaticEntities(text),
    );
    expect(
      diagnostics.events.some(
        (event: { stage?: unknown }) => event.stage === "prepare.cache.hit",
      ),
    ).toBe(true);
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

  test("Python package facade loads compressed package bytes", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const configBytes = Buffer.from(CONFIG_JSON);
    const packageBytes =
      adapters.native.prepareStaticSearchCompressedPackageBytes(configBytes);
    const expectedJson = JSON.parse(
      adapters.native.redactStaticEntitiesJson(CONFIG_JSON, text),
    );
    const result = callPythonPackageFacade({
      pythonModulePath: adapters.pythonModulePath,
      tempDir: adapters.tempDir,
      packageBytes,
      text,
      operators: null,
      compressed: true,
    });

    expect(result.from_bytes).toEqual(expectedJson);
    expect(result.from_file).toEqual(expectedJson);
    expect(result.prepare_stages).toEqual(
      expect.arrayContaining([
        "prepare.package.decode",
        "prepare.package.decompress",
        "prepare.package.config-decode",
        "prepare.artifacts.decode",
      ]),
    );
    expect(result.available_languages).toContain("en");
    expect(result.version).toBe(packageJsonVersion());
    expect(result.module_version).toBe(packageJsonVersion());
  });

  test("shared TS and Python SDK facades match Rust core JSON", () => {
    const adapters = getAdapters();
    const config = JSON.parse(CONFIG_JSON);
    const packageBytes = prepare_search_package({
      binding: adapters.native,
      config: CONFIG_JSON,
      compressed: true,
    });
    const prepared = load_prepared_package({
      binding: adapters.native,
      packageBytes,
    });
    const cases: SharedSdkParityCase[] = [
      {
        text:
          "č Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
          "Prague, matter MAT-123, code Secret Code.",
        operators: null,
      },
      {
        text:
          "🙂 Reference CD9876 for Acme s.r.o. near Fuzztovn, Turkey, " +
          "Prague, matter MAT-456, code Secret Code.",
        operators: {
          operators: { country: "redact", "matter id": "redact" },
          redactString: "***",
        },
      },
    ];

    const tsSdkFunctions: Record<
      (typeof SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS)[number],
      unknown
    > = {
      diagnostics_json,
      diagnostics_stream_json,
      load_prepared_package,
      native_package_version,
      normalize_for_search,
      prepare_search_package,
      redact_text,
      redact_text_json,
      summary_diagnostics_json,
    };
    for (const name of SHARED_NATIVE_SDK_CORE_TOP_LEVEL_FUNCTIONS) {
      expect(typeof tsSdkFunctions[name]).toBe("function");
    }
    const tsSdkClasses: Record<
      (typeof SHARED_NATIVE_SDK_CLASS_NAMES)[number],
      unknown
    > = {
      PreparedAnonymizer,
      PreparedSearch,
    };
    for (const name of SHARED_NATIVE_SDK_CLASS_NAMES) {
      expect(typeof tsSdkClasses[name]).toBe("function");
    }
    const preparedApi = prepared as unknown as Record<string, unknown>;
    for (const name of SHARED_NATIVE_SDK_PREPARED_METHODS) {
      expect(typeof preparedApi[name]).toBe("function");
    }

    expect(native_package_version(adapters.native)).toBe(packageJsonVersion());
    expect(
      normalize_for_search({
        binding: adapters.native,
        text: "Číslo\u00a0PAS - 1234",
      }),
    ).toBe(adapters.native.normalizeForSearch("Číslo\u00a0PAS - 1234"));
    expect([
      ...prepare_search_package({ binding: adapters.native, config }),
    ]).toEqual([...packageBytes]);

    const rustCoreJson = callRustCoreSharedSdkParity({
      tempDir: adapters.tempDir,
      cases,
    });
    const tsSdkJson = cases.map(({ text, operators }) =>
      JSON.parse(prepared.redact_text_json(text, operators ?? undefined)),
    );

    expect(tsSdkJson).toEqual(rustCoreJson);
    expect(
      cases.map(({ text, operators }) =>
        toBindingStaticResult(
          redact_text({
            binding: adapters.native,
            config: CONFIG_JSON,
            fullText: text,
            ...(operators !== null ? { operators } : {}),
          }),
        ),
      ),
    ).toEqual(rustCoreJson);
    expect(
      cases.map(({ text, operators }) =>
        JSON.parse(
          redact_text_json({
            binding: adapters.native,
            config: CONFIG_JSON,
            fullText: text,
            ...(operators !== null ? { operators } : {}),
          }),
        ),
      ),
    ).toEqual(rustCoreJson);
    const diagnosticsJson = prepared.diagnostics_json(cases[0].text);
    if (diagnosticsJson === null) {
      throw new Error("missing shared SDK diagnostics");
    }
    expect(diagnosticsJson).toContain('"diagnostics"');
    const topLevelDiagnosticsJson = diagnostics_json({
      binding: adapters.native,
      config: CONFIG_JSON,
      fullText: cases[0].text,
    });
    if (topLevelDiagnosticsJson === null) {
      throw new Error("missing top-level shared SDK diagnostics");
    }
    expect(topLevelDiagnosticsJson).toContain('"diagnostics"');
    const summaryDiagnosticsJson = prepared.summary_diagnostics_json(
      cases[0].text,
    );
    if (summaryDiagnosticsJson === null) {
      throw new Error("missing shared SDK summary diagnostics");
    }
    expect(summaryDiagnosticsJson).toContain('"diagnostics"');
    const topLevelSummaryDiagnosticsJson = summary_diagnostics_json({
      binding: adapters.native,
      config: CONFIG_JSON,
      fullText: cases[0].text,
    });
    if (topLevelSummaryDiagnosticsJson === null) {
      throw new Error("missing top-level shared SDK summary diagnostics");
    }
    expect(topLevelSummaryDiagnosticsJson).toContain('"diagnostics"');

    const python = callPythonSharedSdkParity({
      pythonModulePath: adapters.pythonModulePath,
      tempDir: adapters.tempDir,
      packageBytes: Buffer.from(packageBytes),
      cases,
      normalizeText: "Číslo\u00a0PAS - 1234",
    });

    expect(python.from_bytes).toEqual(rustCoreJson);
    expect(python.from_file).toEqual(rustCoreJson);
    expect(python.default_from_path).toEqual(rustCoreJson);
    expect(python.top_level).toEqual(rustCoreJson);
    expect(python.top_level_bytes).toEqual(rustCoreJson);
    expect(python.top_level_object_json).toEqual(rustCoreJson);
    expect(python.top_level_object).toEqual(
      rustCoreJson.map(withoutEntityOffsets),
    );
    expect(python.normalized).toBe(
      adapters.native.normalizeForSearch("Číslo\u00a0PAS - 1234"),
    );
    expect(python.available_languages).toContain("en");
    expect(python.version).toBe(packageJsonVersion());
    expect(python.module_version).toBe(packageJsonVersion());
  });

  test("shared TS and Python SDK facades match Rust core JSON for user data", async () => {
    const adapters = getAdapters();
    const config: PipelineConfig = {
      threshold: 0.3,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: true,
      customDenyList: [
        {
          value: "Project Zephyr",
          label: "organization",
          variants: ["Zephyr Project"],
        },
        {
          value: "Mina Roe",
          label: "person",
          variants: ["M. Roe"],
        },
      ],
      customRegexes: [
        {
          pattern: "\\bUSR-[A-Z]{2}\\d{4}\\b",
          label: "registration number",
          score: 0.96,
        },
      ],
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["organization", "person", "registration number"],
      workspaceId: "native-shared-sdk-user-data-parity",
    };
    const bundle = await buildNativeStaticSearchBundle(
      config,
      [],
      createPipelineContext(),
    );
    const configJson = JSON.stringify(bundle.nativeStaticConfig);
    const packageBytes = prepare_search_package({
      binding: adapters.native,
      config: configJson,
      compressed: true,
    });
    const prepared = load_prepared_package({
      binding: adapters.native,
      packageBytes,
    });
    const cases: SharedSdkParityCase[] = [
      {
        text:
          "Project Zephyr assigned USR-AB1234 to Mina Roe. " +
          "Zephyr Project also references M. Roe.",
        operators: null,
      },
      {
        text: "Mina Roe escalated USR-CD9876 after Project Zephyr review.",
        operators: {
          operators: {
            organization: "redact",
            person: "redact",
            "registration number": "redact",
          },
          redactString: "***",
        },
      },
    ];
    const rustCoreJson = callRustCoreSharedSdkParity({
      tempDir: adapters.tempDir,
      cases,
      configJson,
    });
    const tsSdkJson = cases.map(({ text, operators }) =>
      JSON.parse(prepared.redact_text_json(text, operators ?? undefined)),
    );
    const python = callPythonSharedSdkParity({
      pythonModulePath: adapters.pythonModulePath,
      tempDir: adapters.tempDir,
      packageBytes: Buffer.from(packageBytes),
      cases,
      configJson,
      normalizeText: "Project Zephyr USR-AB1234",
    });

    expect(tsSdkJson).toEqual(rustCoreJson);
    expect(python.from_bytes).toEqual(rustCoreJson);
    expect(python.from_file).toEqual(rustCoreJson);
    expect(python.top_level).toEqual(rustCoreJson);
    expect(python.top_level_bytes).toEqual(rustCoreJson);
    expect(python.top_level_object_json).toEqual(rustCoreJson);
    expect(python.top_level_object).toEqual(
      rustCoreJson.map(withoutEntityOffsets),
    );
    expect(rustCoreJson[0]?.resolved_entities.map(({ text }) => text)).toEqual([
      "Project Zephyr",
      "USR-AB1234",
      "Mina Roe",
      "Zephyr Project",
      "M. Roe",
    ]);
    expect(rustCoreJson[1]?.redaction.redacted_text).not.toContain(
      "Project Zephyr",
    );
    expect(python.available_languages).toContain("en");
    expect(python.version).toBe(packageJsonVersion());
    expect(python.module_version).toBe(packageJsonVersion());
  });

  test("default package SDK path matches through TS and Python", () => {
    const adapters = getAdapters();
    const cases = loadContractFixtureCases("en")
      .filter(({ name }) =>
        [
          "healthcare-trust-employment-amendment.txt",
          "software-license-agreement.txt",
        ].includes(name),
      )
      .map(({ text }) => ({ operators: null, text }));
    const tsPipeline = getDefaultNativePipeline({
      binding: adapters.native,
      language: "en",
    });

    expect(
      preloadDefaultNativePipeline({
        binding: adapters.native,
        language: "en",
      }),
    ).toBe(tsPipeline);

    const tsResults = cases.map(({ operators, text }) =>
      toBindingStaticResult(
        tsPipeline.redactText(text, operators ?? undefined),
      ),
    );
    const tsHelperResults = cases.map(({ operators, text }) =>
      toBindingStaticResult(
        redact_default_text(text, operators ?? undefined, {
          binding: adapters.native,
          language: "en",
        }),
      ),
    );
    const tsHelperJsonResults = cases.map(({ operators, text }) =>
      JSON.parse(
        redact_default_text_json(text, operators ?? undefined, {
          binding: adapters.native,
          language: "en",
        }),
      ),
    );
    const python = callPythonDefaultPackageParity({
      cases,
      language: "en",
      pythonModulePath: adapters.pythonModulePath,
      tempDir: adapters.tempDir,
    });

    expect(tsHelperResults).toEqual(tsResults);
    expect(tsHelperJsonResults).toEqual(tsResults);
    expect(python.results).toEqual(tsResults);
    expect(python.helper_results).toEqual(tsResults);
    expect(python.helper_object_results).toEqual(
      tsResults.map(withoutEntityOffsets),
    );
    expect(python.available_languages).toContain("en");
    expect(python.version).toBe(packageJsonVersion());
    expect(python.module_version).toBe(packageJsonVersion());
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

  test("native pipeline package matches TS static pipeline redaction", async () => {
    const adapters = getAdapters();
    const fullText =
      "Project Nebula and Blue Harbour signed MAT-123 on 2024-01-02. " +
      "Acme s.r.o.\n/s/ Jane Doe";
    const config: PipelineConfig = {
      threshold: 0.3,
      enableTriggerPhrases: true,
      enableRegex: true,
      enableLegalForms: true,
      enableNameCorpus: false,
      enableDenyList: true,
      customDenyList: [
        {
          value: "Project Nebula",
          label: "organization",
          variants: ["Nebula Programme"],
        },
      ],
      customRegexes: [
        { pattern: "\\bMAT-\\d{3}\\b", label: "matter id", score: 1 },
      ],
      enableGazetteer: true,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["organization", "date", "person", "matter id"],
      workspaceId: "native-pipeline-static-test",
    };
    const gazetteerEntries = [
      {
        id: "blue-harbour",
        canonical: "Blue Harbor Capital",
        label: "organization",
        variants: ["Blue Harbour"],
        workspaceId: "native-pipeline-static-test",
        createdAt: 0,
        source: "manual" as const,
      },
    ];
    const operators: NativeOperatorConfig & OperatorConfig = {
      operators: { "matter id": "redact" },
      redactString: "***",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      gazetteerEntries,
      context: createPipelineContext(),
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries,
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS address context redaction", async () => {
    const adapters = getAdapters();
    const fullText =
      "ACME s.r.o.\nEvropska 710\n160 00 Praha\n" + "body ".repeat(200);
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      customRegexes: [
        { pattern: "ACME s\\.r\\.o\\.", label: "organization", score: 1 },
      ],
      labels: ["organization", "address"],
      workspaceId: "native-pipeline-address-context-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context: createPipelineContext(),
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsContext = createPipelineContext();
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "address", text: "Evropska 710" }),
      ]),
    );
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS confidence boost redaction", async () => {
    const adapters = getAdapters();
    const fullText = "ANCHOR-123 signed with NEAR-456.";
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: true,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      customRegexes: [
        {
          pattern: "\\bANCHOR-\\d+\\b",
          label: "registration number",
          score: 0.95,
        },
        { pattern: "\\bNEAR-\\d+\\b", label: "matter id", score: 0.45 },
      ],
      labels: ["registration number", "matter id"],
      workspaceId: "native-pipeline-confidence-boost-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities.some(({ text }) => text === "NEAR-456")).toBe(true);
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches trigger-only legal suffix reclassification", async () => {
    const adapters = getAdapters();
    const fullText = "jednatelem Novák Partners s.r.o. na základě plné moci.";
    const config: PipelineConfig = {
      threshold: 0.3,
      enableTriggerPhrases: true,
      enableRegex: false,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["organization"],
      workspaceId: "native-pipeline-trigger-suffix-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "organization",
          text: expect.stringContaining("s.r.o."),
          source: "trigger",
        }),
      ]),
    );
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS hotword reclassification", async () => {
    const adapters = getAdapters();
    const fullText = "narozen dne 12.03.1990 v Praze";
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: true,
      enableZoneClassification: false,
      labels: ["date of birth"],
      workspaceId: "native-pipeline-hotword-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "date of birth",
          text: "12.03.1990",
        }),
      ]),
    );
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS organization propagation", async () => {
    const adapters = getAdapters();
    const fullText = "Acme LLC signed. Acme paid.";
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: true,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: true,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["organization"],
      workspaceId: "native-pipeline-coreference-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "organization",
          text: "Acme",
          source: "coreference",
          corefSourceText: "Acme LLC",
        }),
      ]),
    );
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package keeps org propagation suffixes in TS parity", async () => {
    const adapters = getAdapters();
    const fullText = "Acme Kft. signed. Acme paid.";
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: true,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: true,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["organization"],
      workspaceId: "native-pipeline-coreference-suffix-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context: createPipelineContext(),
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(
      tsEntities.some(
        (entity) => entity.source === "coreference" && entity.text === "Acme",
      ),
    ).toBe(false);
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS trigger monetary widening", async () => {
    const adapters = getAdapters();
    const fullText =
      "Smluvní pokuta je sjednána ve výši 50.000,- Kč (slovy: padesát tisíc korun českých).";
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: true,
      enableRegex: false,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["monetary amount"],
      workspaceId: "native-pipeline-trigger-money-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context: createPipelineContext(),
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "monetary amount",
          text: "50.000,- Kč (slovy: padesát tisíc korun českých)",
        }),
      ]),
    );
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS zone score adjustments", async () => {
    const adapters = getAdapters();
    const fullText = ["Parties", "Alice", "Article 1", "Body"].join("\n");
    const config: PipelineConfig = {
      threshold: 0.5,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: true,
      customRegexes: [{ pattern: "Alice", label: "person", score: 0.45 }],
      labels: ["person"],
      workspaceId: "native-pipeline-zone-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual([
      expect.objectContaining({ label: "person", text: "Alice", score: 0.55 }),
    ]);
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS standalone name corpus", async () => {
    const adapters = getAdapters();
    const fullText = "The agreement is signed by Mina Roe.";
    const config: PipelineConfig = {
      threshold: 0.85,
      enableTriggerPhrases: false,
      enableRegex: false,
      enableLegalForms: false,
      enableNameCorpus: true,
      enableDenyList: false,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      nameCorpusLanguages: ["x-test"],
      dictionaries: {
        firstNames: { "x-test": ["Mina"] },
        surnames: { "x-test": ["Roe"] },
      },
      labels: ["person"],
      workspaceId: "native-pipeline-standalone-name-corpus-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual([
      expect.objectContaining({
        label: "person",
        text: "Mina Roe",
        score: 0.9,
      }),
    ]);
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline package matches TS supplemental name corpus", async () => {
    const adapters = getAdapters();
    const fullText = "The agreement is signed by Sato Kenji.";
    const config: PipelineConfig = {
      threshold: 0.85,
      enableTriggerPhrases: false,
      enableRegex: false,
      enableLegalForms: false,
      enableNameCorpus: true,
      enableDenyList: true,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["person"],
      workspaceId: "native-pipeline-name-corpus-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);

    expect(tsEntities).toEqual([
      expect.objectContaining({
        label: "person",
        text: "Sato Kenji",
        score: 0.9,
      }),
    ]);
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline keeps supplemental names outside address seeds", async () => {
    const adapters = getAdapters();
    const fullText =
      "Sato Kenji, address: 100 Main Street, Boston, MA 02101-1234.";
    const config: PipelineConfig = {
      threshold: 0.85,
      enableTriggerPhrases: false,
      enableRegex: false,
      enableLegalForms: false,
      enableNameCorpus: true,
      enableDenyList: true,
      enableGazetteer: false,
      enableCountries: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["person", "address"],
      workspaceId: "native-pipeline-name-address-boundary-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });

    const context = createPipelineContext();
    const packageBytes = await prepareNativePipelinePackage({
      binding: adapters.native,
      config,
      context,
      compressed: true,
    });
    const nativePipeline = createNativePipelineFromPackage({
      binding: adapters.native,
      packageBytes,
    });
    const tsContext = createPipelineContext();
    const operators: OperatorConfig & NativeOperatorConfig = {
      operators: {},
      redactString: "[REDACTED]",
    };
    const tsEntities = await runPipeline({
      fullText,
      config,
      gazetteerEntries: [],
      context: tsContext,
    });
    const tsRedaction = redactText(fullText, tsEntities, operators, tsContext);
    const address = tsEntities.find((entity) => entity.label === "address");

    expect(tsEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "person", text: "Sato Kenji" }),
      ]),
    );
    expect(address?.text).toContain("100 Main Street");
    expect(address?.text).not.toContain("Sato Kenji");
    expect(
      toBindingStaticResult(nativePipeline.redactText(fullText, operators)),
    ).toEqual({
      resolved_entities: tsEntities.map(toBindingEntity),
      redaction: toBindingRedactionResult(tsRedaction),
    });
  });

  test("native pipeline compatibility rejects TS-only contextual passes", () => {
    const config: PipelineConfig = {
      threshold: 0.3,
      enableTriggerPhrases: true,
      enableRegex: true,
      enableLegalForms: true,
      enableNameCorpus: true,
      enableDenyList: true,
      enableGazetteer: false,
      enableNer: true,
      enableConfidenceBoost: true,
      enableCoreference: true,
      enableHotwordRules: true,
      enableZoneClassification: true,
      labels: [...DEFAULT_ENTITY_LABELS],
      workspaceId: "native-pipeline-compat-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "unsupported",
      unsupportedFeatures: ["enableNer"],
    });
  });

  test("native pipeline compatibility accepts address context passes", () => {
    const config: PipelineConfig = {
      threshold: 0.85,
      enableTriggerPhrases: false,
      enableRegex: true,
      enableLegalForms: false,
      enableNameCorpus: false,
      enableDenyList: false,
      enableGazetteer: false,
      enableNer: false,
      enableConfidenceBoost: false,
      enableCoreference: false,
      enableHotwordRules: false,
      enableZoneClassification: false,
      labels: ["address"],
      workspaceId: "native-pipeline-address-context-test",
    };

    expect(getNativePipelineCompatibility(config)).toEqual({
      status: "supported",
    });
  });

  slowNativeFixtureParityTest(
    "native facade and Python match on contract fixture packages",
    async () => {
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
          dictionaryScope.nameCorpusLanguages =
            scopedConfig.nameCorpusLanguages;
        }
        const dictionaries = await loadTestDictionaries(dictionaryScope);
        const { nativeStaticConfig } = await buildNativeStaticSearchBundle(
          {
            ...scopedConfig,
            dictionaries,
          },
          [],
          createPipelineContext(),
        );
        const configJson = JSON.stringify(nativeStaticConfig);
        const packageBytes = prepareNativeSearchPackage({
          binding: adapters.native,
          config: nativeStaticConfig,
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
    },
    SLOW_NATIVE_FIXTURE_PARITY_TIMEOUT_MS,
  );

  slowNativeFixtureParityTest(
    "native fixture improvements are explicit",
    async () => {
      const adapters = getAdapters();
      const languages = [
        ...new Set(NATIVE_FIXTURE_IMPROVEMENTS.map(({ language }) => language)),
      ];

      for (const language of languages) {
        const fixtures = new Map(
          loadContractFixtureCases(language).map(({ name, text }) => [
            name,
            text,
          ]),
        );
        const scopedConfig = applyPipelineLanguageScope({
          ...contractTestConfig(`native-fixture-improvements-${language}`),
          language,
        });
        const dictionaryScope: Parameters<typeof loadTestDictionaries>[0] = {};
        if (scopedConfig.denyListCountries !== undefined) {
          dictionaryScope.denyListCountries = scopedConfig.denyListCountries;
        }
        if (scopedConfig.nameCorpusLanguages !== undefined) {
          dictionaryScope.nameCorpusLanguages =
            scopedConfig.nameCorpusLanguages;
        }
        const dictionaries = await loadTestDictionaries(dictionaryScope);
        const { nativeStaticConfig } = await buildNativeStaticSearchBundle(
          {
            ...scopedConfig,
            dictionaries,
          },
          [],
          createPipelineContext(),
        );
        const packageBytes = prepareNativeSearchPackage({
          binding: adapters.native,
          config: nativeStaticConfig,
          compressed: true,
        });
        const anonymizer = createNativeAnonymizerFromPackage({
          binding: adapters.native,
          packageBytes,
        });

        for (const improvement of NATIVE_FIXTURE_IMPROVEMENTS.filter(
          (item) => item.language === language,
        )) {
          const text = fixtures.get(improvement.fixture);
          expect(text).toBeDefined();
          if (text === undefined) {
            continue;
          }

          const result = toBindingStaticResult(
            anonymizer.redactStaticEntities(text),
          );
          for (const entity of improvement.includes ?? []) {
            expectNativeFixtureEntity(result, entity);
          }
          for (const entity of improvement.excludes ?? []) {
            expectNativeFixtureEntityAbsent(result, entity);
          }
        }
      }
    },
  );

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
          event.stage === "find.literal" &&
          event.kind === "stage-summary" &&
          typeof event.slot === "number" &&
          typeof event.pattern_count === "number" &&
          event.pattern_count > 0,
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.some(
        (event) =>
          event.stage === "prepare.regex" &&
          event.kind === "stage-summary" &&
          typeof event.slot === "number" &&
          typeof event.pattern_count === "number" &&
          typeof event.artifact_count === "number" &&
          typeof event.artifact_bytes === "number",
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

  test("summary diagnostics JSON is identical through TS and Python adapters", () => {
    const adapters = getAdapters();
    const text =
      "Reference AB1234 for Acme s.r.o. near Fuzztovn, Turkey, " +
      "Prague, matter MAT-123, code Secret Code.";
    const operators = { country: "redact" };

    const tsResult = runTsSummaryDiagnosticsAdapter(
      adapters.native,
      text,
      operators,
    );
    const pyResult = callPythonSummaryDiagnostics(
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
          event.stage === "detect.total" &&
          event.kind === "stage-summary" &&
          typeof event.elapsed_us === "number",
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.some(
        (event) =>
          event.stage === "redact.total" &&
          event.kind === "stage-summary" &&
          typeof event.elapsed_us === "number",
      ),
    ).toBe(true);
    expect(
      tsResult.diagnostics.events.every(
        (event) => event.kind === "stage-summary",
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

  ensureDefaultNativePackageArtifacts();

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
  const pythonPackageDir = join(tempDir, "stella_anonymize");
  mkdirSync(pythonPackageDir);
  const pythonModulePath = join(pythonPackageDir, "_native.so");
  copyFileSync(nativeLibraryPath("stella_anonymize_napi"), napiPath);
  copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), pythonModulePath);
  copyFileSync(
    join(PYTHON_SOURCE_DIR, "stella_anonymize", "__init__.py"),
    join(pythonPackageDir, "__init__.py"),
  );
  cpSync(
    join(PYTHON_SOURCE_DIR, "stella_anonymize", "native_packages"),
    join(pythonPackageDir, "native_packages"),
    { recursive: true },
  );

  const native = loadNativeAdapter(napiPath);
  loadedAdapters = { native, pythonModulePath, tempDir };
  return loadedAdapters;
};

const ensureDefaultNativePackageArtifacts = () => {
  const packageDir = join(ROOT_DIR, "packages", "anonymize");
  const requiredPackages = [
    "native-pipeline.stlanonpkg",
    ...CONTRACT_FIXTURE_LANGUAGES.map(
      (language) => `native-pipeline.${language}.stlanonpkg`,
    ),
  ];
  if (
    requiredPackages.every((fileName) => existsSync(join(packageDir, fileName)))
  ) {
    return;
  }

  runCommand(
    "bun",
    ["run", "build"],
    {
      STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES:
        CONTRACT_FIXTURE_LANGUAGES.join(","),
    },
    packageDir,
  );
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
  const redactStaticEntitiesSummaryDiagnosticsJson = Reflect.get(
    Object(loaded),
    "redactStaticEntitiesSummaryDiagnosticsJson",
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
    typeof redactStaticEntitiesDiagnosticsJson !== "function" ||
    typeof redactStaticEntitiesSummaryDiagnosticsJson !== "function"
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
    redactStaticEntitiesSummaryDiagnosticsJson,
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

const runTsSummaryDiagnosticsAdapter = (
  adapter: NativeAdapter,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionDiagnosticResult => {
  const operatorsJson = operatorConfigJson(operators);
  return JSON.parse(
    adapter.redactStaticEntitiesSummaryDiagnosticsJson(
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
    "_native",
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

type PythonPackageFacadeOptions = {
  pythonModulePath: string;
  tempDir: string;
  packageBytes: Buffer;
  text: string;
  operators: Record<string, string> | null;
  compressed: boolean;
};

const callPythonPackageFacade = ({
  pythonModulePath,
  tempDir,
  packageBytes,
  text,
  operators,
  compressed,
}: PythonPackageFacadeOptions): {
  available_languages: string[];
  from_bytes: StaticRedactionResult;
  from_file: StaticRedactionResult;
  prepare_stages: string[];
  module_version: string;
  version: string;
} => {
  const payloadPath = join(tempDir, "package-facade-payload.json");
  const packagePath = join(tempDir, "package-facade.bin");
  writeFileSync(packagePath, packageBytes);
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      text,
      operators_json: operatorConfigJson(operators),
      compressed,
    }),
  );
  const output = runCommand("python3", ["-c", PYTHON_PACKAGE_FACADE_SCRIPT], {
    STELLA_ANONYMIZE_PACKAGE: packagePath,
    STELLA_ANONYMIZE_PAYLOAD: payloadPath,
    STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
  });
  return JSON.parse(output);
};

type RustCoreSharedSdkParityOptions = {
  tempDir: string;
  cases: SharedSdkParityCase[];
  configJson?: string;
};

const callRustCoreSharedSdkParity = ({
  tempDir,
  cases,
  configJson = CONFIG_JSON,
}: RustCoreSharedSdkParityOptions): StaticRedactionResult[] => {
  const payloadPath = join(tempDir, "rust-core-shared-sdk-payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: configJson,
      cases: cases.map(({ text, operators }) => ({
        text,
        operators_json: nativeOperatorConfigJson(operators),
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
      "--locked",
      "--quiet",
    ],
    {
      STELLA_ANONYMIZE_PARITY_PAYLOAD: payloadPath,
    },
  );
  return JSON.parse(output);
};

type PythonSharedSdkParityOptions = {
  pythonModulePath: string;
  tempDir: string;
  packageBytes: Buffer;
  cases: SharedSdkParityCase[];
  configJson?: string;
  normalizeText: string;
};

const callPythonSharedSdkParity = ({
  pythonModulePath,
  tempDir,
  packageBytes,
  cases,
  configJson = CONFIG_JSON,
  normalizeText,
}: PythonSharedSdkParityOptions): {
  default_from_path: StaticRedactionResult[];
  from_bytes: StaticRedactionResult[];
  from_file: StaticRedactionResult[];
  top_level: StaticRedactionResult[];
  top_level_bytes: StaticRedactionResult[];
  top_level_object: OffsetFreeStaticRedactionResult[];
  top_level_object_json: StaticRedactionResult[];
  available_languages: string[];
  normalized: string;
  module_version: string;
  version: string;
} => {
  const payloadPath = join(tempDir, "shared-sdk-payload.json");
  const packagePath = join(tempDir, "shared-sdk-package.bin");
  writeFileSync(packagePath, packageBytes);
  writeFileSync(
    payloadPath,
    JSON.stringify({
      cases: cases.map(({ text, operators }) => ({
        text,
        operators: operators?.operators ?? null,
        redact_string: operators?.redactString,
      })),
      class_names: SHARED_NATIVE_SDK_CLASS_NAMES,
      compressed: true,
      config_object: JSON.parse(configJson),
      config_json: configJson,
      default_package_functions: SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS,
      default_package_names: PYTHON_NATIVE_SDK_DEFAULT_PACKAGE_NAMES,
      normalize_text: normalizeText,
      prepared_methods: SHARED_NATIVE_SDK_PREPARED_METHODS,
      public_type_names: PYTHON_NATIVE_SDK_PUBLIC_TYPE_NAMES,
      top_level_functions: SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS,
    }),
  );
  const output = runCommand(
    "python3",
    ["-c", PYTHON_SHARED_SDK_PARITY_SCRIPT],
    {
      STELLA_ANONYMIZE_PACKAGE: packagePath,
      STELLA_ANONYMIZE_PAYLOAD: payloadPath,
      STELLA_ANONYMIZE_PY_MODULE: pythonModulePath,
    },
  );
  return JSON.parse(output);
};

type PythonDefaultPackageParityOptions = {
  pythonModulePath: string;
  tempDir: string;
  language: string;
  cases: SharedSdkParityCase[];
};

const callPythonDefaultPackageParity = ({
  pythonModulePath,
  tempDir,
  language,
  cases,
}: PythonDefaultPackageParityOptions): {
  available_languages: string[];
  helper_object_results: OffsetFreeStaticRedactionResult[];
  helper_results: StaticRedactionResult[];
  results: StaticRedactionResult[];
  module_version: string;
  version: string;
} => {
  const payloadPath = join(tempDir, "default-package-sdk-payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      cases: cases.map(({ text, operators }) => ({
        text,
        operators: operators?.operators ?? null,
      })),
      language,
    }),
  );
  const output = runCommand(
    "python3",
    ["-c", PYTHON_DEFAULT_PACKAGE_PARITY_SCRIPT],
    {
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
): StaticRedactionDiagnosticResult =>
  callPythonDiagnosticsFunction({
    pythonModulePath,
    text,
    operators,
    functionName: "redact_static_entities_diagnostics_json",
  });

const callPythonSummaryDiagnostics = (
  pythonModulePath: string,
  text: string,
  operators: Record<string, string> | null,
): StaticRedactionDiagnosticResult =>
  callPythonDiagnosticsFunction({
    pythonModulePath,
    text,
    operators,
    functionName: "redact_static_entities_summary_diagnostics_json",
  });

type PythonDiagnosticsFunctionOptions = {
  pythonModulePath: string;
  text: string;
  operators: Record<string, string> | null;
  functionName:
    | "redact_static_entities_diagnostics_json"
    | "redact_static_entities_summary_diagnostics_json";
};

const callPythonDiagnosticsFunction = ({
  pythonModulePath,
  text,
  operators,
  functionName,
}: PythonDiagnosticsFunctionOptions): StaticRedactionDiagnosticResult => {
  const operatorsJson = operatorConfigJson(operators);
  const payloadDir = mkdtempSync(
    join(tmpdir(), "stella-anonymize-diagnostics-"),
  );
  const payloadPath = join(payloadDir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      config_json: CONFIG_JSON,
      text,
      operators_json: operatorsJson,
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
    "_native",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(payload_path.read_text())
diagnostics_function = getattr(
    module,
    os.environ["STELLA_ANONYMIZE_DIAGNOSTICS_FUNCTION"],
)
print(
    diagnostics_function(
        payload["config_json"],
        payload["text"],
        payload.get("operators_json"),
    )
)
`,
      ],
      {
        STELLA_ANONYMIZE_DIAGNOSTICS_FUNCTION: functionName,
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

const toBindingEntity = (
  entity: Entity,
): StaticRedactionResult["resolved_entities"][number] => ({
  start: entity.start,
  end: entity.end,
  label: entity.label,
  text: entity.text,
  score: entity.score,
  source: entity.source,
  source_detail: entity.sourceDetail ?? null,
});

const toBindingRedactionResult = (
  result: RedactionResult,
): StaticRedactionResult["redaction"] => ({
  redacted_text: result.redactedText,
  redaction_map: [...result.redactionMap.entries()].map(
    ([placeholder, original]) => ({ placeholder, original }),
  ),
  operator_map: [...result.operatorMap.entries()].map(
    ([placeholder, operator]) => ({ placeholder, operator }),
  ),
  entity_count: result.entityCount,
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

const withoutEntityOffsets = ({
  resolved_entities,
  redaction,
}: StaticRedactionResult): OffsetFreeStaticRedactionResult => ({
  resolved_entities: resolved_entities.map(
    ({ start: _start, end: _end, ...entity }) => entity,
  ),
  redaction,
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

const findNativeFixtureEntity = (
  result: StaticRedactionResult,
  expected: ExpectedNativeFixtureEntity,
) =>
  result.resolved_entities.find(
    (entity) =>
      entity.label === expected.label &&
      entity.text === expected.text &&
      (expected.source === undefined || entity.source === expected.source),
  );

const expectNativeFixtureEntity = (
  result: StaticRedactionResult,
  expected: ExpectedNativeFixtureEntity,
) => {
  expect(findNativeFixtureEntity(result, expected)).toMatchObject(expected);
};

const expectNativeFixtureEntityAbsent = (
  result: StaticRedactionResult,
  expected: ExpectedNativeFixtureEntity,
) => {
  expect(findNativeFixtureEntity(result, expected)).toBeUndefined();
};

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

const nativeOperatorConfigJson = (
  operators: NativeOperatorConfig | null,
): string | undefined => {
  if (operators === null) {
    return undefined;
  }
  return JSON.stringify(operators);
};

const runCommand = (
  command: string,
  args: string[],
  env: Record<string, string> = {},
  cwd: string = ROOT_DIR,
): string => {
  const result = spawnSync(command, args, {
    cwd,
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
