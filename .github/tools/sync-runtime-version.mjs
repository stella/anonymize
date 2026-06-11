import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$/;

const PACKAGE_FILES = [
  "packages/anonymize/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
];

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

if (hasMismatch) {
  process.exit(1);
}
