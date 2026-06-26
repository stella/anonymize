import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const outDir = mkdtempSync(join(tmpdir(), "stella-anonymize-wheel-"));
const profile = process.env.ANONYMIZE_PYTHON_WHEEL_PROFILE ?? "ci";

try {
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
  ];
  const missing = required.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`wheel is missing files: ${missing.join(", ")}`);
  }
  if (![...files].some(isNativeExtension)) {
    throw new Error("wheel is missing the native _native extension");
  }

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

function isNativeExtension(file) {
  return (
    file.startsWith("stella_anonymize/_native.") &&
    [".so", ".pyd", ".dll", ".dylib"].some((suffix) => file.endsWith(suffix))
  );
}
