import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

const sourceByPlatform = {
  darwin: "libstella_anonymize_napi.dylib",
  linux: "libstella_anonymize_napi.so",
  win32: "stella_anonymize_napi.dll",
};

const sourceName = sourceByPlatform[process.platform];
if (!sourceName) {
  throw new Error(`Unsupported native build platform: ${process.platform}`);
}

execFileSync(
  "cargo",
  ["build", "-p", "stella-anonymize-napi", "--release", "--locked"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

const source = join(repoRoot, "target", "release", sourceName);
if (!existsSync(source)) {
  throw new Error(`Native build output is missing: ${source}`);
}

copyFileSync(source, join(packageRoot, "stella_anonymize_napi.node"));

execFileSync(
  process.execPath,
  [
    join(packageRoot, "scripts", "build-native-pipeline-package.mjs"),
    "--out",
    join(packageRoot, "native-pipeline.stlanonpkg"),
    "--default-dictionaries",
  ],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);
