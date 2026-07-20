import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$/;

const PACKAGE_FILES = [
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
const ROOT_RUNTIME_PACKAGE_FILE = "packages/anonymize/package.json";
const ROOT_NATIVE_OPTIONAL_DEPENDENCIES = [
  "@stll/anonymize-darwin-arm64",
  "@stll/anonymize-darwin-x64",
  "@stll/anonymize-linux-arm64-gnu",
  "@stll/anonymize-linux-x64-gnu",
  "@stll/anonymize-win32-x64-msvc",
];

const CARGO_WORKSPACE_MANIFEST = "Cargo.toml";
const CARGO_LOCKED_PACKAGES = [
  "stella-anonymize-adapter-contract",
  "stella-anonymize-core",
  "stella-anonymize-docx-core",
  "stella-anonymize-napi",
  "stella-anonymize-py",
];
const PYPROJECT_FILES = ["crates/anonymize-py/pyproject.toml"];
const LOCK_FILE = "bun.lock";
const CARGO_LOCK_FILE = "Cargo.lock";
const checkOnly = process.argv.includes("--check");
const version = readFileSync("VERSION", "utf8").trim();

if (!VERSION_RE.test(version)) {
  console.error(
    `VERSION must look like 1.2.3, 1.2.3-rc.1, 1.2.3-beta.1, or 1.2.3-alpha.1; got '${version}'`,
  );
  process.exit(1);
}

let hasMismatch = false;

// Internal dependency ranges that must track the synchronized runtime train.
const SYNCED_DEPENDENCIES = ["@stll/anonymize", "@stll/anonymize-docx"];

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Windows runners check out with CRLF line endings; the version regexes below
// anchor on "\n", so normalize before matching (files are written back LF-only).
const readTextFile = (file) =>
  readFileSync(file, "utf8").replaceAll("\r\n", "\n");

const syncTextVersion = ({ file, label, re }) => {
  const text = readTextFile(file);
  const match = text.match(re);
  if (!match) {
    console.error(`${file} has no ${label} version entry`);
    hasMismatch = true;
    return;
  }
  const current = match[2];
  if (current === version) {
    return;
  }
  if (checkOnly) {
    console.error(
      `${file} has ${label} version ${current}; expected ${version}`,
    );
    hasMismatch = true;
    return;
  }
  writeFileSync(file, text.replace(re, `$1${version}$3`));
  console.log(`Updated ${file} ${label} version to ${version}`);
};

for (const file of PACKAGE_FILES) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const wantedRange = `^${version}`;
  const mismatchedDependencies = SYNCED_DEPENDENCIES.flatMap((dependency) => {
    const dependencyRange = pkg.dependencies?.[dependency];
    if (dependencyRange === undefined || dependencyRange === wantedRange) {
      return [];
    }
    return [{ dependency, dependencyRange }];
  });
  if (pkg.version === version && mismatchedDependencies.length === 0) {
    continue;
  }

  if (checkOnly) {
    if (pkg.version !== version) {
      console.error(`${file} has version ${pkg.version}; expected ${version}`);
    }
    for (const { dependency, dependencyRange } of mismatchedDependencies) {
      console.error(
        `${file} depends on ${dependency}@${dependencyRange}; expected ${wantedRange}`,
      );
    }
    hasMismatch = true;
    continue;
  }

  pkg.version = version;
  for (const { dependency } of mismatchedDependencies) {
    pkg.dependencies[dependency] = wantedRange;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Updated ${file} to ${version}`);
}

{
  const pkg = JSON.parse(readFileSync(ROOT_RUNTIME_PACKAGE_FILE, "utf8"));
  const wantedVersion = version;
  let changed = false;
  for (const dependency of ROOT_NATIVE_OPTIONAL_DEPENDENCIES) {
    const current = pkg.optionalDependencies?.[dependency];
    if (current === wantedVersion) {
      continue;
    }
    if (checkOnly) {
      console.error(
        `${ROOT_RUNTIME_PACKAGE_FILE} optional dependency ${dependency}@${current}; expected ${wantedVersion}`,
      );
      hasMismatch = true;
      continue;
    }
    pkg.optionalDependencies ??= {};
    pkg.optionalDependencies[dependency] = wantedVersion;
    changed = true;
  }
  if (changed) {
    writeFileSync(
      ROOT_RUNTIME_PACKAGE_FILE,
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    console.log(
      `Updated ${ROOT_RUNTIME_PACKAGE_FILE} native optional dependency versions to ${wantedVersion}`,
    );
  }
}

syncTextVersion({
  file: CARGO_WORKSPACE_MANIFEST,
  label: "Cargo workspace",
  re: /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/,
});

for (const file of PYPROJECT_FILES) {
  const text = readTextFile(file);
  const explicitVersion = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (explicitVersion) {
    syncTextVersion({
      file,
      label: "Python project",
      re: /(^version\s*=\s*")([^"]+)(")/m,
    });
    continue;
  }

  if (/\bdynamic\s*=\s*\[[^\]]*"version"[^\]]*\]/m.test(text)) {
    continue;
  }

  console.error(
    `${file} must either derive version dynamically from Cargo or match VERSION`,
  );
  hasMismatch = true;
}

const lockText = readTextFile(LOCK_FILE);
let lockChanged = false;
let syncedLockText = lockText;

for (const dependency of SYNCED_DEPENDENCIES) {
  const syncedDependency = syncDependencyRangeLockVersion(
    syncedLockText,
    dependency,
  );
  syncedLockText = syncedDependency.text;
  lockChanged ||= syncedDependency.changed;
  hasMismatch ||= syncedDependency.hasMismatch;
}

for (const dependency of ROOT_NATIVE_OPTIONAL_DEPENDENCIES) {
  const syncedSidecar = syncNativeOptionalDependencyLockVersion(
    syncedLockText,
    dependency,
  );
  syncedLockText = syncedSidecar.text;
  lockChanged ||= syncedSidecar.changed;
  hasMismatch ||= syncedSidecar.hasMismatch;
}

for (const file of PACKAGE_FILES) {
  const workspace = dirname(file);
  const workspaceVersionRe = new RegExp(
    `("${escapeRegExp(workspace)}": \\{\\n\\s+"name": "[^"]+",\\n\\s+"version": ")([^"]+)(")`,
  );
  const match = syncedLockText.match(workspaceVersionRe);
  if (!match) {
    console.error(
      `${LOCK_FILE} has no version entry for workspace ${workspace}`,
    );
    hasMismatch = true;
    continue;
  }
  const lockedVersion = match[2];
  if (lockedVersion === version) {
    continue;
  }
  if (checkOnly) {
    console.error(
      `${LOCK_FILE} workspace ${workspace} has version ${lockedVersion}; expected ${version}`,
    );
    hasMismatch = true;
    continue;
  }
  syncedLockText = syncedLockText.replace(workspaceVersionRe, `$1${version}$3`);
  lockChanged = true;
}

if (lockChanged) {
  writeFileSync(LOCK_FILE, syncedLockText);
  console.log(
    `Updated ${LOCK_FILE} workspace versions and runtime dependency ranges to ${version}`,
  );
}

const cargoLockText = readTextFile(CARGO_LOCK_FILE);
let cargoLockChanged = false;
let syncedCargoLockText = cargoLockText;

for (const packageName of CARGO_LOCKED_PACKAGES) {
  const packageVersionRe = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")([^"]+)(")`,
  );
  const match = syncedCargoLockText.match(packageVersionRe);
  if (!match) {
    console.error(`${CARGO_LOCK_FILE} has no package entry for ${packageName}`);
    hasMismatch = true;
    continue;
  }
  const lockedVersion = match[2];
  if (lockedVersion === version) {
    continue;
  }
  if (checkOnly) {
    console.error(
      `${CARGO_LOCK_FILE} package ${packageName} has version ${lockedVersion}; expected ${version}`,
    );
    hasMismatch = true;
    continue;
  }
  syncedCargoLockText = syncedCargoLockText.replace(
    packageVersionRe,
    `$1${version}$3`,
  );
  cargoLockChanged = true;
}

if (cargoLockChanged) {
  writeFileSync(CARGO_LOCK_FILE, syncedCargoLockText);
  console.log(
    `Updated ${CARGO_LOCK_FILE} local package versions to ${version}`,
  );
}

if (hasMismatch) {
  process.exit(1);
}

function syncNativeOptionalDependencyLockVersion(text, dependency) {
  const sidecarVersionRe = new RegExp(
    `("${escapeRegExp(dependency)}": ")([^"]+)(")`,
    "g",
  );
  let found = false;
  let changed = false;
  let mismatched = false;
  const syncedText = text.replaceAll(
    sidecarVersionRe,
    (match, prefix, lockedVersion, suffix) => {
      found = true;
      if (lockedVersion === version) {
        return match;
      }
      if (checkOnly) {
        console.error(
          `${LOCK_FILE} has ${dependency}@${lockedVersion}; expected ${version}`,
        );
        mismatched = true;
        return match;
      }
      changed = true;
      return `${prefix}${version}${suffix}`;
    },
  );
  if (!found) {
    console.error(`${LOCK_FILE} has no optional dependency ${dependency}`);
    mismatched = true;
  }
  return {
    text: syncedText,
    changed,
    hasMismatch: mismatched,
  };
}

function syncDependencyRangeLockVersion(text, dependency) {
  const dependencyRangeRe = new RegExp(
    `("${escapeRegExp(dependency)}": "\\^)([^"]+)(")`,
    "g",
  );
  let found = false;
  let changed = false;
  let mismatched = false;
  const syncedText = text.replaceAll(
    dependencyRangeRe,
    (match, prefix, lockedVersion, suffix) => {
      found = true;
      if (lockedVersion === version) {
        return match;
      }
      if (checkOnly) {
        console.error(
          `${LOCK_FILE} has ${dependency}@^${lockedVersion}; expected ^${version}`,
        );
        mismatched = true;
        return match;
      }
      changed = true;
      return `${prefix}${version}${suffix}`;
    },
  );
  if (!found) {
    console.error(`${LOCK_FILE} has no dependency range for ${dependency}`);
    mismatched = true;
  }
  return {
    text: syncedText,
    changed,
    hasMismatch: mismatched,
  };
}
