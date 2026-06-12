import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$/;

const PACKAGE_FILES = [
  "packages/anonymize/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
];

const LOCK_FILE = "bun.lock";
const checkOnly = process.argv.includes("--check");
const version = readFileSync("VERSION", "utf8").trim();

if (!VERSION_RE.test(version)) {
  console.error(
    `VERSION must look like 1.2.3, 1.2.3-rc.1, 1.2.3-beta.1, or 1.2.3-alpha.1; got '${version}'`,
  );
  process.exit(1);
}

let hasMismatch = false;

// Internal dependency ranges that must track the synced
// version (the CLI consumes the runtime it ships with).
const SYNCED_DEPENDENCY = "@stll/anonymize";
const SYNCED_DEPENDENCY_RANGE_RE = /("@stll\/anonymize": "\^)([^"]+)(")/g;

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const file of PACKAGE_FILES) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const wantedRange = `^${version}`;
  const dependencyRange = pkg.dependencies?.[SYNCED_DEPENDENCY];
  const dependencyInSync =
    dependencyRange === undefined || dependencyRange === wantedRange;
  if (pkg.version === version && dependencyInSync) {
    continue;
  }

  if (checkOnly) {
    if (pkg.version !== version) {
      console.error(`${file} has version ${pkg.version}; expected ${version}`);
    }
    if (!dependencyInSync) {
      console.error(
        `${file} depends on ${SYNCED_DEPENDENCY}@${dependencyRange}; expected ${wantedRange}`,
      );
    }
    hasMismatch = true;
    continue;
  }

  pkg.version = version;
  if (!dependencyInSync) {
    pkg.dependencies[SYNCED_DEPENDENCY] = wantedRange;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Updated ${file} to ${version}`);
}

const lockText = readFileSync(LOCK_FILE, "utf8");
let lockChanged = false;
let syncedLockText = lockText.replaceAll(
  SYNCED_DEPENDENCY_RANGE_RE,
  (match, prefix, lockedVersion, suffix) => {
    if (lockedVersion === version) {
      return match;
    }
    if (checkOnly) {
      console.error(
        `${LOCK_FILE} has ${SYNCED_DEPENDENCY}@^${lockedVersion}; expected ^${version}`,
      );
      hasMismatch = true;
      return match;
    }
    lockChanged = true;
    return `${prefix}${version}${suffix}`;
  },
);

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
    `Updated ${LOCK_FILE} workspace versions and ${SYNCED_DEPENDENCY} ranges to ${version}`,
  );
}

if (hasMismatch) {
  process.exit(1);
}
