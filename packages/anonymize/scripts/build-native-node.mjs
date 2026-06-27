import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const DEFAULT_SCOPED_PACKAGE_LANGUAGES = ["cs", "de", "en"];
const SCOPED_PACKAGE_PATTERN =
  /^native-pipeline\.[a-z0-9]+(?:-[a-z0-9]+)*\.stlanonpkg$/u;
const scopedPackageLanguages = languageListFromEnv(
  process.env.STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES,
  DEFAULT_SCOPED_PACKAGE_LANGUAGES,
);

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
removeScopedNativePipelinePackages();

buildNativePipelinePackage([
  "--out",
  join(packageRoot, "native-pipeline.stlanonpkg"),
  "--default-dictionaries",
]);

for (const language of scopedPackageLanguages) {
  buildNativePipelinePackage([
    "--out",
    join(packageRoot, `native-pipeline.${language}.stlanonpkg`),
    "--default-dictionaries",
    "--language",
    language,
  ]);
}

function buildNativePipelinePackage(args) {
  execFileSync(
    process.execPath,
    [
      join(packageRoot, "scripts", "build-native-pipeline-package.mjs"),
      ...args,
    ],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );
}

function removeScopedNativePipelinePackages() {
  for (const entry of readdirSync(packageRoot)) {
    if (!SCOPED_PACKAGE_PATTERN.test(entry)) {
      continue;
    }
    rmSync(join(packageRoot, entry), { force: true });
  }
}

function languageListFromEnv(value, defaultLanguages) {
  if (value === undefined) {
    return defaultLanguages;
  }
  if (value.trim().length === 0) {
    return [];
  }
  const languages = value
    .split(",")
    .map((entry) => normalizeLanguage(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  if (languages.length === 0) {
    throw new Error("STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES is empty");
  }
  return languages;
}

function normalizeLanguage(value) {
  const language = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(language)) {
    throw new Error(
      `Invalid STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES entry: ${value}`,
    );
  }
  return language;
}
