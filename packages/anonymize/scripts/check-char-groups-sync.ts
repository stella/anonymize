import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundledPath = resolve(
  here,
  "../src/util/char-groups-data.json",
);
const sourcePath = resolve(
  here,
  "../../data/config/char-groups.json",
);

const bundled = readFileSync(bundledPath, "utf8");
const source = readFileSync(sourcePath, "utf8");

if (bundled !== source) {
  throw new Error(
    [
      "Bundled char groups are out of sync.",
      `Expected ${bundledPath} to match ${sourcePath}.`,
      "Copy the canonical config into the bundled file before building.",
    ].join("\n"),
  );
}
