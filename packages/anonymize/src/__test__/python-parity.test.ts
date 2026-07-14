/**
 * Python-binding parity.
 *
 * Drives the Rust `crates/anonymize-py` extension in a subprocess and asserts
 * its default-package redaction output is byte-for-byte identical to the
 * in-process native binding output on the committed contract fixtures. Both
 * sides load the same prepared default packages and call into the same Rust
 * core, so any divergence is a binding-layer bug (offset math, JSON shape,
 * version drift), not a detector difference.
 *
 * The comparison target is the NATIVE binding, not the legacy TypeScript
 * pipeline: the native SDK is the 2.0 reference implementation.
 *
 * Building the Python extension (a debug `cargo build`) is expensive, so the
 * suite is gated behind ANONYMIZE_TEST_SLOW_NATIVE_FIXTURE_PARITY=1 and skips
 * cleanly otherwise (matching the slow-fixture-parity gating in
 * native-adapter-parity.test.ts).
 */
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
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

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  getDefaultNativePipeline,
  loadNativeAnonymizeBinding,
  redact_default_text_json,
} from "../native-node";

setDefaultTimeout(600_000);

const RUN_PYTHON_PARITY =
  process.env["ANONYMIZE_TEST_SLOW_NATIVE_FIXTURE_PARITY"] === "1";
const pythonParityTest = RUN_PYTHON_PARITY ? test : test.skip;

const ROOT_DIR = join(import.meta.dir, "..", "..", "..", "..");
const TARGET_DIR = join(ROOT_DIR, "target", "debug");
const PACKAGE_DIR = join(ROOT_DIR, "packages", "anonymize");
const PYTHON_SOURCE_DIR = join(ROOT_DIR, "crates", "anonymize-py", "python");
const CONTRACT_FIXTURES_DIR = join(
  PACKAGE_DIR,
  "src",
  "__test__",
  "fixtures",
  "contracts",
);
const CONTRACT_FIXTURE_LANGUAGES = ["cs", "de", "en"] as const;

type FixtureLanguage = (typeof CONTRACT_FIXTURE_LANGUAGES)[number];

type ParityCase = {
  language: FixtureLanguage;
  name: string;
  text: string;
};

type PythonParityOutput = {
  results: unknown[];
  available_languages: string[];
  version: string;
  module_version: string;
  caller_result: {
    redacted_text: string;
    start: number;
    end: number;
    source: string;
    diagnostic_start: number;
    diagnostic_end: number;
    kept_text: string;
    keep_map_count: number;
    keep_operator: string;
    masked_text: string;
    mask_map_count: number;
    mask_operator: string;
  };
  session_result: {
    session_id: string;
    mapping_count: number;
    restored_mapping_count: number;
    first_placeholder: string;
    second_placeholder: string;
    restored_placeholder: string;
    restored_text: string;
    object_start: number;
    object_end: number;
    json_start: number;
    json_end: number;
  };
  lifecycle_result: {
    active_status: string;
    expired_status: string;
    schema_version: number;
    restored_expiry: number | null;
    deleted_mapping_count: number;
    deleted_status: string;
  };
  archive_result: {
    archive_base64: string;
    restored_mapping_count: number;
    restored_placeholder: string;
    wrong_key_rejected: boolean;
    wrong_session_id_rejected: boolean;
    invalid_key_rejected: boolean;
    oversized_archive_rejected: boolean;
    lifecycle_restored_status: string;
    missing_observed_at_rejected: boolean;
    expired_restore_rejected: boolean;
  };
};

const PYTHON_PARITY_SCRIPT = `
import base64
import json
import os
import pathlib
import sys

module_root = pathlib.Path(os.environ["STELLA_ANONYMIZE_PY_MODULE"]).parent.parent
payload = json.loads(pathlib.Path(os.environ["STELLA_ANONYMIZE_PAYLOAD"]).read_text())
sys.path.insert(0, str(module_root))

import stella_anonymize as anonymize

caller_result = json.loads(
    anonymize.get_default_native_pipeline(language="en").redact_text_with_caller_detections_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
    )
)
caller_diagnostics = json.loads(
    anonymize.get_default_native_pipeline(language="en").redact_text_with_caller_detections_diagnostics_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
    )
)
caller_diagnostic_entity = next(
    event for event in caller_diagnostics["diagnostics"]["events"]
    if event.get("stage") == "entity.caller.input" and event.get("kind") == "entity"
)
caller_keep_result = json.loads(
    anonymize.get_default_native_pipeline(language="en").redact_text_with_caller_detections_json(
        "😀Alice signed.",
        [{"start": 1, "end": 6, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-1"}],
        {"person": "keep"},
    )
)
caller_mask_result = json.loads(
    anonymize.get_default_native_pipeline(language="en").redact_text_with_caller_detections_json(
        "A👨‍👩‍👧‍👦éZ signed.",
        [{"start": 0, "end": 11, "label": "person", "score": 0.9,
          "provider_id": "parity-provider", "detection_id": "person-mask-1"}],
        {"person": {"type": "mask", "masking_character": "●",
                    "characters_to_mask": 2, "direction": "end"}},
    )
)
prepared = anonymize.get_default_native_pipeline(language="en")
session = prepared.create_redaction_session("parity_session_1")
session_first = session.redact_text("Jan Novak signed.")
session_second = session.redact_text("Jan Novak signed again.")
session_object_offsets = session.redact_text("😀Jan Novak signed.")
session_json_offsets = json.loads(session.redact_text_json("😀Jan Novak signed."))
restored_session = prepared.restore_redaction_session(session.to_plaintext_json())
session_restored = restored_session.redact_text("Jan Novak signed once more.")
session_restored_text = restored_session.restore_text(
    session_first.redaction.redaction_map[0].placeholder + " signed."
)
archive_key = bytes([0x42]) * 32
session_archive = session.to_encrypted_archive(archive_key)
encrypted_restored_session = prepared.restore_encrypted_redaction_session(
    session_archive, archive_key, "parity_session_1"
)
encrypted_session_restored = encrypted_restored_session.redact_text(
    "Jan Novak signed from an archive."
)

def rejects_value_error(callback):
    try:
        callback()
    except ValueError:
        return True
    return False

wrong_key_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        session_archive, bytes([0x43]) * 32, "parity_session_1"
    )
)
wrong_session_id_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        session_archive, archive_key, "different_session_1"
    )
)
invalid_key_rejected = rejects_value_error(
    lambda: session.to_encrypted_archive(bytes([0x42]) * 31)
)
oversized_archive_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        bytes(0x01000000 + 58), archive_key, "parity_session_1"
    )
)
lifecycle_session = prepared.create_redaction_session_with_lifecycle(
    "parity_lifecycle_1",
    created_at_epoch_seconds=100,
    expires_at_epoch_seconds=200,
)
lifecycle_session.redact_text_at(
    "Jan Novak signed.", observed_at_epoch_seconds=150
)
lifecycle_active = lifecycle_session.inspect(150)
lifecycle_archive = lifecycle_session.to_encrypted_archive_at(archive_key, 150)
lifecycle_archive_restored = prepared.restore_encrypted_redaction_session(
    lifecycle_archive,
    archive_key,
    "parity_lifecycle_1",
    observed_at_epoch_seconds=150,
)
missing_observed_at_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        lifecycle_archive, archive_key, "parity_lifecycle_1"
    )
)
expired_restore_rejected = rejects_value_error(
    lambda: prepared.restore_encrypted_redaction_session(
        lifecycle_archive,
        archive_key,
        "parity_lifecycle_1",
        observed_at_epoch_seconds=200,
    )
)
lifecycle_state = json.loads(lifecycle_session.to_plaintext_json_at(150))
lifecycle_restored = prepared.restore_redaction_session(
    json.dumps(lifecycle_state, separators=(",", ":"))
)
lifecycle_expired = lifecycle_restored.inspect(200)
lifecycle_deleted = lifecycle_session.delete()
lifecycle_deleted_metadata = lifecycle_session.inspect()

print(
    json.dumps(
        {
            "results": [
                json.loads(
                    anonymize.redact_default_text_json(
                        case["text"], None, language=case["language"]
                    )
                )
                for case in payload["cases"]
            ],
            "available_languages": list(
                anonymize.available_default_native_pipeline_languages()
            ),
            "version": anonymize.native_package_version(),
            "module_version": anonymize.__version__,
            "caller_result": {
                "redacted_text": caller_result["redaction"]["redacted_text"],
                "start": caller_result["resolved_entities"][0]["start"],
                "end": caller_result["resolved_entities"][0]["end"],
                "source": caller_result["resolved_entities"][0]["source"],
                "diagnostic_start": caller_diagnostic_entity["start"],
                "diagnostic_end": caller_diagnostic_entity["end"],
                "kept_text": caller_keep_result["redaction"]["redacted_text"],
                "keep_map_count": len(caller_keep_result["redaction"]["redaction_map"]),
                "keep_operator": caller_keep_result["redaction"]["operator_map"][0]["operator"],
                "masked_text": caller_mask_result["redaction"]["redacted_text"],
                "mask_map_count": len(caller_mask_result["redaction"]["redaction_map"]),
                "mask_operator": caller_mask_result["redaction"]["operator_map"][0]["operator"],
            },
            "session_result": {
                "session_id": restored_session.session_id(),
                "mapping_count": session.mapping_count(),
                "restored_mapping_count": restored_session.mapping_count(),
                "first_placeholder": session_first.redaction.redaction_map[0].placeholder,
                "second_placeholder": session_second.redaction.redaction_map[0].placeholder,
                "restored_placeholder": session_restored.redaction.redaction_map[0].placeholder,
                "restored_text": session_restored_text,
                "object_start": session_object_offsets.resolved_entities[0].start,
                "object_end": session_object_offsets.resolved_entities[0].end,
                "json_start": session_json_offsets["resolved_entities"][0]["start"],
                "json_end": session_json_offsets["resolved_entities"][0]["end"],
            },
            "lifecycle_result": {
                "active_status": lifecycle_active["status"],
                "expired_status": lifecycle_expired["status"],
                "schema_version": lifecycle_state["schema_version"],
                "restored_expiry": lifecycle_expired["expires_at_epoch_seconds"],
                "deleted_mapping_count": lifecycle_deleted["deleted_mapping_count"],
                "deleted_status": lifecycle_deleted_metadata["status"],
            },
            "archive_result": {
                "archive_base64": base64.b64encode(session_archive).decode("ascii"),
                "restored_mapping_count": encrypted_restored_session.mapping_count(),
                "restored_placeholder": encrypted_session_restored.redaction.redaction_map[0].placeholder,
                "wrong_key_rejected": wrong_key_rejected,
                "wrong_session_id_rejected": wrong_session_id_rejected,
                "invalid_key_rejected": invalid_key_rejected,
                "oversized_archive_rejected": oversized_archive_rejected,
                "lifecycle_restored_status": lifecycle_archive_restored.inspect(150)["status"],
                "missing_observed_at_rejected": missing_observed_at_rejected,
                "expired_restore_rejected": expired_restore_rejected,
            },
        }
    )
)
`;

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

const nativeLibraryPath = (name: string): string => {
  if (process.platform === "darwin") {
    return join(TARGET_DIR, `lib${name}.dylib`);
  }
  if (process.platform === "linux") {
    return join(TARGET_DIR, `lib${name}.so`);
  }
  return join(TARGET_DIR, `${name}.dll`);
};

const ensureDefaultPackages = (): void => {
  const required = [
    "native-pipeline.stlanonpkg",
    ...CONTRACT_FIXTURE_LANGUAGES.map(
      (language) => `native-pipeline.${language}.stlanonpkg`,
    ),
  ];
  if (required.every((file) => existsSync(join(PACKAGE_DIR, file)))) {
    return;
  }
  runCommand("bun", ["run", "--cwd", PACKAGE_DIR, "build"], {
    STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES:
      CONTRACT_FIXTURE_LANGUAGES.join(","),
  });
};

let pythonModulePath: string | null = null;
let pythonModuleTempDir: string | null = null;

afterAll(() => {
  if (pythonModuleTempDir !== null) {
    try {
      rmSync(pythonModuleTempDir, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup: a leftover temp dir must not fail the suite.
    }
    pythonModuleTempDir = null;
  }
});

const getPythonModule = (): string => {
  if (pythonModulePath !== null) {
    return pythonModulePath;
  }
  ensureDefaultPackages();
  runCommand("cargo", ["build", "-p", "stella-anonymize-py", "--locked"]);

  const tempDir = mkdtempSync(join(tmpdir(), "stella-anonymize-py-parity-"));
  pythonModuleTempDir = tempDir;
  const packageDir = join(tempDir, "stella_anonymize");
  mkdirSync(packageDir);
  const modulePath = join(packageDir, "_native.so");
  copyFileSync(nativeLibraryPath("stella_anonymize_core_py"), modulePath);
  copyFileSync(
    join(PYTHON_SOURCE_DIR, "stella_anonymize", "__init__.py"),
    join(packageDir, "__init__.py"),
  );
  cpSync(
    join(PYTHON_SOURCE_DIR, "stella_anonymize", "native_packages"),
    join(packageDir, "native_packages"),
    { recursive: true },
  );
  pythonModulePath = modulePath;
  return pythonModulePath;
};

const loadContractFixtureCases = (): ParityCase[] =>
  CONTRACT_FIXTURE_LANGUAGES.flatMap((language) =>
    readdirSync(join(CONTRACT_FIXTURES_DIR, language))
      .filter((name) => name.endsWith(".txt"))
      .toSorted()
      .map((name) => ({
        language,
        name,
        text: readFileSync(join(CONTRACT_FIXTURES_DIR, language, name), "utf8"),
      })),
  );

const runPythonParity = (cases: ParityCase[]): PythonParityOutput => {
  const modulePath = getPythonModule();
  const payloadPath = join(
    tmpdir(),
    `stella-anonymize-py-payload-${Date.now()}.json`,
  );
  writeFileSync(
    payloadPath,
    JSON.stringify({
      cases: cases.map(({ text, language }) => ({ text, language })),
    }),
  );
  try {
    return JSON.parse(
      runCommand("python3", ["-c", PYTHON_PARITY_SCRIPT], {
        STELLA_ANONYMIZE_PAYLOAD: payloadPath,
        STELLA_ANONYMIZE_PY_MODULE: modulePath,
      }),
    ) as PythonParityOutput;
  } finally {
    rmSync(payloadPath, { force: true });
  }
};

const nativeDefaultRedaction = (
  binding: ReturnType<typeof loadNativeAnonymizeBinding>,
  { text, language }: ParityCase,
): unknown =>
  JSON.parse(redact_default_text_json(text, undefined, { binding, language }));

const packageJsonVersion = (): string => {
  const { version } = JSON.parse(
    readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof version !== "string") {
    throw new TypeError("package.json version is missing");
  }
  return version;
};

describe("python binding parity", () => {
  pythonParityTest(
    "default-package redaction matches the native binding across contract fixtures",
    () => {
      const cases = loadContractFixtureCases();
      expect(cases.length).toBeGreaterThan(0);

      const binding = loadNativeAnonymizeBinding();
      const nativeResults = cases.map((item) =>
        nativeDefaultRedaction(binding, item),
      );

      const python = runPythonParity(cases);

      expect(python.results).toEqual(nativeResults);
      for (const language of CONTRACT_FIXTURE_LANGUAGES) {
        expect(python.available_languages).toContain(language);
      }
    },
  );

  pythonParityTest(
    "python binding reports the package manifest version",
    () => {
      const python = runPythonParity([]);
      expect(python.version).toBe(packageJsonVersion());
      expect(python.module_version).toBe(packageJsonVersion());
    },
  );

  pythonParityTest("caller detections use Python character offsets", () => {
    const python = runPythonParity([]);
    expect(python.caller_result).toEqual({
      redacted_text: "😀[PERSON_1] signed.",
      start: 1,
      end: 6,
      source: "caller",
      diagnostic_start: 1,
      diagnostic_end: 6,
      kept_text: "😀Alice signed.",
      keep_map_count: 0,
      keep_operator: "keep",
      masked_text: "A👨‍👩‍👧‍👦●● signed.",
      mask_map_count: 0,
      mask_operator: "mask",
    });
  });

  pythonParityTest("python sessions preserve mappings across transfer", () => {
    const python = runPythonParity([]);
    expect(python.session_result).toEqual({
      session_id: "parity_session_1",
      mapping_count: 1,
      restored_mapping_count: 1,
      first_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      second_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      restored_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      restored_text: "Jan Novak signed.",
      object_start: 1,
      object_end: 10,
      json_start: 2,
      json_end: 11,
    });
    expect(python.lifecycle_result).toEqual({
      active_status: "active",
      expired_status: "expired",
      schema_version: 2,
      restored_expiry: 200,
      deleted_mapping_count: 1,
      deleted_status: "deleted",
    });
    expect(python.archive_result).toMatchObject({
      restored_mapping_count: 1,
      restored_placeholder: "[PERSON_parity%5Fsession%5F1_1]",
      wrong_key_rejected: true,
      wrong_session_id_rejected: true,
      invalid_key_rejected: true,
      oversized_archive_rejected: true,
      lifecycle_restored_status: "active",
      missing_observed_at_rejected: true,
      expired_restore_rejected: true,
    });

    const binding = loadNativeAnonymizeBinding();
    const native = getDefaultNativePipeline({ binding, language: "en" });
    const restored = native.restoreEncryptedRedactionSession({
      archive: new Uint8Array(
        Buffer.from(python.archive_result.archive_base64, "base64"),
      ),
      key: new Uint8Array(32).fill(0x42),
      expectedSessionId: "parity_session_1",
    });
    expect(
      restored
        .redactText("Jan Novak signed in Node.")
        .redaction.redactionMap.has("[PERSON_parity%5Fsession%5F1_1]"),
    ).toBe(true);
  });
});
