import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const PACKAGE_MANAGER_RE = /^bun@[0-9]+\.[0-9]+\.[0-9]+$/;
const WORKFLOWS_DIR = ".github/workflows";
const SETUP_BUN_RE = /uses:\s*oven-sh\/setup-bun@/;
const BUN_VERSION_ENV_RE = /^\s*BUN_VERSION\s*:/;
const BUN_VERSION_INPUT_RE = /^\s*bun-version\s*:/;
const BUN_VERSION_FILE_RE =
  /^\s*bun-version-file\s*:\s*["']?package\.json["']?\s*$/;

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageManager = packageJson.packageManager;
let hasMismatch = false;

if (!PACKAGE_MANAGER_RE.test(packageManager)) {
  console.error(
    `package.json packageManager must pin Bun as bun@x.y.z; got ${String(packageManager)}`,
  );
  hasMismatch = true;
}

const isConfigLine = (line) => !line.trimStart().startsWith("#");
const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => join(WORKFLOWS_DIR, file));

for (const file of workflowFiles) {
  const lines = readFileSync(file, "utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    if (!isConfigLine(line)) {
      continue;
    }
    if (BUN_VERSION_ENV_RE.test(line)) {
      console.error(`${file}:${index + 1} must not define BUN_VERSION`);
      hasMismatch = true;
    }
    if (BUN_VERSION_INPUT_RE.test(line)) {
      console.error(
        `${file}:${index + 1} must use bun-version-file: "package.json"`,
      );
      hasMismatch = true;
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!isConfigLine(line) || !SETUP_BUN_RE.test(line)) {
      continue;
    }

    const followingStep = lines
      .slice(index + 1)
      .findIndex(
        (candidate) =>
          isConfigLine(candidate) && /^\s*-\s+(name|uses)\s*:/.test(candidate),
      );
    const endIndex =
      followingStep === -1 ? lines.length : index + 1 + followingStep;
    const setupBlock = lines.slice(index + 1, endIndex);

    if (setupBlock.some((candidate) => BUN_VERSION_FILE_RE.test(candidate))) {
      continue;
    }

    console.error(
      `${file}:${index + 1} setup-bun must use bun-version-file: "package.json"`,
    );
    hasMismatch = true;
  }
}

if (hasMismatch) {
  process.exit(1);
}
