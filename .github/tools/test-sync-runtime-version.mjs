import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const syncScript = join(
  repoRoot,
  ".github",
  "tools",
  "sync-runtime-version.mjs",
);
let workspace;
// Windows runners check out with CRLF line endings; the sync script must
// handle both, so the whole scenario runs once per line ending.
let lineEnding = "\n";
const version = "9.8.7";
const staleVersion = "9.8.6";

const packageFiles = [
  "packages/anonymize/package.json",
  "packages/anonymize-darwin-arm64/package.json",
  "packages/anonymize-darwin-x64/package.json",
  "packages/anonymize-linux-arm64-gnu/package.json",
  "packages/anonymize-linux-x64-gnu/package.json",
  "packages/anonymize-win32-x64-msvc/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
  "packages/document-docx/package.json",
];

const sidecars = [
  "@stll/anonymize-darwin-arm64",
  "@stll/anonymize-darwin-x64",
  "@stll/anonymize-linux-arm64-gnu",
  "@stll/anonymize-linux-x64-gnu",
  "@stll/anonymize-win32-x64-msvc",
];

for (const scenarioLineEnding of ["\n", "\r\n"]) {
  lineEnding = scenarioLineEnding;
  workspace = mkdtempSync(join(tmpdir(), "stella-version-sync-"));
  try {
    writeFixture();

    const staleCheck = spawnSync("node", [syncScript, "--check"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (staleCheck.status === 0 || !staleCheck.stderr.includes(sidecars[0])) {
      throw new Error(
        `stale sidecar versions were not reported (${JSON.stringify(lineEnding)})`,
      );
    }

    execFileSync("node", [syncScript], { cwd: workspace, stdio: "pipe" });
    execFileSync("node", [syncScript, "--check"], {
      cwd: workspace,
      stdio: "pipe",
    });

    const rootPackage = JSON.parse(
      readFileSync(join(workspace, "packages/anonymize/package.json"), "utf8"),
    );
    for (const sidecar of sidecars) {
      if (rootPackage.optionalDependencies?.[sidecar] !== version) {
        throw new Error(`package.json did not sync ${sidecar}`);
      }
    }

    const lockText = readFileSync(join(workspace, "bun.lock"), "utf8");
    if (lockText.includes(staleVersion)) {
      throw new Error("bun.lock still contains stale sidecar versions");
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}

function writeFixture() {
  writeText("VERSION", `${version}\n`);
  writeText("Cargo.toml", `[workspace.package]\nversion = "${version}"\n`);
  writeText(
    "crates/anonymize-py/pyproject.toml",
    '[project]\ndynamic = ["version"]\n',
  );
  writeText(
    "Cargo.lock",
    [
      cargoPackage("stella-anonymize-adapter-contract"),
      cargoPackage("stella-anonymize-core"),
      cargoPackage("stella-anonymize-napi"),
      cargoPackage("stella-anonymize-py"),
    ].join("\n"),
  );

  for (const file of packageFiles) {
    const name = packageNameFor(file);
    const pkg = { name, version };
    if (file === "packages/anonymize/package.json") {
      pkg.optionalDependencies = Object.fromEntries(
        sidecars.map((sidecar) => [sidecar, staleVersion]),
      );
    }
    if (file === "packages/cli/package.json") {
      pkg.dependencies = { "@stll/anonymize": `^${staleVersion}` };
    }
    writeText(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  writeText("bun.lock", bunLockFixture());
}

function cargoPackage(name) {
  return `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
}

function packageNameFor(file) {
  if (file === "packages/anonymize/package.json") {
    return "@stll/anonymize";
  }
  if (file === "packages/anonymize/wasm/package.json") {
    return "@stll/anonymize-wasm";
  }
  if (file === "packages/cli/package.json") {
    return "@stll/anonymize-cli";
  }
  if (file === "packages/document-docx/package.json") {
    return "@stll/anonymize-docx";
  }
  return `@stll/${file.replace("packages/", "").replace("/package.json", "")}`;
}

function bunLockFixture() {
  return `${JSON.stringify(
    {
      lockfileVersion: 1,
      workspaces: {
        "packages/anonymize": {
          name: "@stll/anonymize",
          version,
          optionalDependencies: Object.fromEntries(
            sidecars.map((sidecar) => [sidecar, staleVersion]),
          ),
        },
        "packages/anonymize-darwin-arm64": {
          name: "@stll/anonymize-darwin-arm64",
          version,
        },
        "packages/anonymize-darwin-x64": {
          name: "@stll/anonymize-darwin-x64",
          version,
        },
        "packages/anonymize-linux-arm64-gnu": {
          name: "@stll/anonymize-linux-arm64-gnu",
          version,
        },
        "packages/anonymize-linux-x64-gnu": {
          name: "@stll/anonymize-linux-x64-gnu",
          version,
        },
        "packages/anonymize-win32-x64-msvc": {
          name: "@stll/anonymize-win32-x64-msvc",
          version,
        },
        "packages/anonymize/wasm": {
          name: "@stll/anonymize-wasm",
          version,
        },
        "packages/cli": {
          name: "@stll/anonymize-cli",
          version,
          dependencies: { "@stll/anonymize": `^${staleVersion}` },
        },
        "packages/document-docx": {
          name: "@stll/anonymize-docx",
          version,
        },
      },
    },
    null,
    2,
  )}\n`;
}

function writeText(file, text) {
  const path = join(workspace, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replaceAll("\n", lineEnding));
}
