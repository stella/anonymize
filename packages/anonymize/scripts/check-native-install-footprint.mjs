import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MEBIBYTE = 1024 * 1024;
const MAX_NATIVE_INSTALL_BYTES = 70 * MEBIBYTE;
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);

if (packageManifest.optionalDependencies?.["@stll/anonymize-wasm"]) {
  throw new Error(
    "@stll/anonymize must not install the browser WASM runtime as an optional dependency",
  );
}
if (Object.keys(packageManifest.dependencies ?? {}).length > 0) {
  throw new Error(
    "native install footprint must account for every runtime dependency",
  );
}

const sidecarName = nativeSidecarName();
const rootBytes = packedUnpackedBytes(packageRoot);
const sidecarBytes = packedUnpackedBytes(
  join(repoRoot, "packages", sidecarName),
);
const installedBytes = rootBytes + sidecarBytes;

if (installedBytes > MAX_NATIVE_INSTALL_BYTES) {
  throw new Error(
    `packed native install is ${formatMebibytes(installedBytes)}, above the ${formatMebibytes(MAX_NATIVE_INSTALL_BYTES)} ceiling`,
  );
}

console.log(
  JSON.stringify({
    event: "native-install-footprint",
    maxMiB: MAX_NATIVE_INSTALL_BYTES / MEBIBYTE,
    nativeSidecar: sidecarName,
    ok: true,
    packedUnpackedMiB: Number((installedBytes / MEBIBYTE).toFixed(1)),
  }),
);

function packedUnpackedBytes(directory) {
  const output = execFileSync(
    npmExecutable,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: directory, encoding: "utf8" },
  );
  const pack = JSON.parse(output).at(0);
  if (!pack || typeof pack.unpackedSize !== "number") {
    throw new Error(`npm did not report an unpacked size for ${directory}`);
  }
  return pack.unpackedSize;
}

function nativeSidecarName() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "anonymize-darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "anonymize-darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "anonymize-linux-arm64-gnu";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "anonymize-linux-x64-gnu";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "anonymize-win32-x64-msvc";
  }
  throw new Error(
    `native install footprint is unsupported on ${process.platform}-${process.arch}`,
  );
}

function formatMebibytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}
