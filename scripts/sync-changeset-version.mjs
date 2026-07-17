import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const RUNTIME_PACKAGE_FILE = "packages/anonymize/package.json";
const VERSION_FILE = "VERSION";
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$/;

const { version } = JSON.parse(readFileSync(RUNTIME_PACKAGE_FILE, "utf8"));
if (typeof version !== "string" || !VERSION_RE.test(version)) {
  console.error(`${RUNTIME_PACKAGE_FILE} has invalid version '${version}'`);
  process.exit(1);
}

writeFileSync(VERSION_FILE, `${version}\n`);
execFileSync(process.execPath, [".github/tools/sync-runtime-version.mjs"], {
  stdio: "inherit",
});
