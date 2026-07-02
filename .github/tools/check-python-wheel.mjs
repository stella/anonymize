import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const outDir = mkdtempSync(join(tmpdir(), "stella-anonymize-wheel-"));
const profile = process.env.ANONYMIZE_PYTHON_WHEEL_PROFILE ?? "ci";
const nativePackagePattern =
  /^native-pipeline(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.stlanonpkg$/u;
const nativePackageSourceDir = join("packages", "anonymize");
const pythonNativePackageDir = join(
  "crates",
  "anonymize-py",
  "python",
  "stella_anonymize",
  "native_packages",
);

try {
  syncNativePipelinePackages();
  execFileSync(
    "uvx",
    [
      "--from",
      "maturin>=1.14,<2",
      "maturin",
      "build",
      "--manifest-path",
      "crates/anonymize-py/Cargo.toml",
      "--locked",
      "--profile",
      profile,
      "--out",
      outDir,
    ],
    { stdio: "inherit" },
  );

  const wheel = readdirSync(outDir).find((file) => file.endsWith(".whl"));
  if (wheel === undefined) {
    throw new Error("maturin did not emit a wheel");
  }

  const wheelPath = join(outDir, wheel);
  const files = new Set(JSON.parse(readWheelFiles(wheelPath)));
  const required = [
    "stella_anonymize/__init__.py",
    "stella_anonymize/__init__.pyi",
    "stella_anonymize/_native.pyi",
    "stella_anonymize/py.typed",
    "stella_anonymize/native_packages/native-pipeline.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.cs.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.de.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.en.stlanonpkg",
  ];
  const missing = required.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`wheel is missing files: ${missing.join(", ")}`);
  }
  if (![...files].some(isNativeExtension)) {
    throw new Error("wheel is missing the native _native extension");
  }
  smokeInstalledWheel(wheelPath);

  console.log(
    JSON.stringify({
      event: "python-wheel-check",
      wheel,
      profile,
    }),
  );
} finally {
  rmSync(outDir, { force: true, recursive: true });
}

function syncNativePipelinePackages() {
  if (!existsSync(nativePackageSourceDir)) {
    throw new Error(
      `native package source is missing: ${nativePackageSourceDir}`,
    );
  }
  mkdirSync(pythonNativePackageDir, { recursive: true });
  for (const file of readdirSync(pythonNativePackageDir)) {
    if (nativePackagePattern.test(file)) {
      rmSync(join(pythonNativePackageDir, file), { force: true });
    }
  }

  const copied = [];
  for (const file of readdirSync(nativePackageSourceDir)) {
    if (!nativePackagePattern.test(file)) {
      continue;
    }
    copyFileSync(
      join(nativePackageSourceDir, file),
      join(pythonNativePackageDir, basename(file)),
    );
    copied.push(file);
  }
  if (!copied.includes("native-pipeline.stlanonpkg")) {
    throw new Error("native-pipeline.stlanonpkg has not been built");
  }
}

function readWheelFiles(wheelPath) {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import json, sys, zipfile",
        "with zipfile.ZipFile(sys.argv[1]) as wheel:",
        "    print(json.dumps(wheel.namelist()))",
      ].join("\n"),
      wheelPath,
    ],
    { encoding: "utf8" },
  );
}

function smokeInstalledWheel(wheelPath) {
  execFileSync(
    "uv",
    [
      "run",
      "--isolated",
      "--no-project",
      "--python",
      "3.11",
      "--with",
      wheelPath,
      "python",
      "-c",
      [
        "import json",
        "import stella_anonymize as anonymize",
        "required = [",
        "    'PreparedAnonymizer',",
        "    'PreparedSearch',",
        "    'available_default_native_pipeline_languages',",
        "    'get_default_native_pipeline',",
        "    'load_prepared_package',",
        "    'preload_default_native_pipeline',",
        "    'prepare_search_package',",
        "    'read_default_native_pipeline_package_file',",
        "    'redact_text',",
        "]",
        "missing = [name for name in required if not hasattr(anonymize, name)]",
        "if missing:",
        "    raise SystemExit(f'missing exports: {missing}')",
        "available_languages = anonymize.available_default_native_pipeline_languages()",
        "if 'en' not in available_languages:",
        "    raise SystemExit(f'missing default English package: {available_languages}')",
        "config_json = json.dumps({",
        "    'regex_patterns': [{'kind': 'regex', 'pattern': r'\\b[A-Z]{2}\\d{4}\\b'}],",
        "    'slices': {'regex': {'start': 0, 'end': 1}},",
        "    'regex_meta': [{'label': 'registration number', 'score': 1.0}],",
        "})",
        "package_bytes = anonymize.prepare_search_package(config_json)",
        "prepared = anonymize.load_prepared_package(package_bytes)",
        "result = prepared.redact_text('Reference AB1234')",
        "if result.redaction.entity_count != 1:",
        "    raise SystemExit(f'unexpected entity count: {result.redaction.entity_count}')",
        "if result.redaction.redacted_text == 'Reference AB1234':",
        "    raise SystemExit('redaction did not change text')",
        "default_bytes = anonymize.read_default_native_pipeline_package_file(language='en')",
        "if len(default_bytes) == 0:",
        "    raise SystemExit('default package is empty')",
        "default_prepared = anonymize.get_default_native_pipeline(language='en')",
        "if default_prepared is not anonymize.get_default_native_pipeline(language='en'):",
        "    raise SystemExit('default package cache did not reuse prepared search')",
        "if anonymize.preload_default_native_pipeline(language='en') is not default_prepared:",
        "    raise SystemExit('preload did not return cached default package')",
        "if anonymize.__version__ != anonymize.native_package_version():",
        "    raise SystemExit('module version did not match native version')",
        "print(json.dumps({",
        "    'event': 'python-wheel-import-smoke',",
        "    'version': anonymize.__version__,",
        "    'entity_count': result.redaction.entity_count,",
        "}))",
      ].join("\n"),
    ],
    { stdio: "inherit" },
  );
}

function isNativeExtension(file) {
  return (
    file.startsWith("stella_anonymize/_native.") &&
    [".so", ".pyd", ".dll", ".dylib"].some((suffix) => file.endsWith(suffix))
  );
}
