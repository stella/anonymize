import process from "node:process";
import { execFileSync } from "node:child_process";

const PACKAGES = [
  {
    dir: "packages/anonymize",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "README.md",
      "LICENSE",
      "package.json",
    ],
  },
  {
    dir: "packages/data",
    expected: [
      "dist/index.d.ts",
      "dist/index.js",
      "README.md",
      "LICENSE",
      "ATTRIBUTION.md",
      "CHANGELOG.md",
      "package.json",
      "config/manifest.json",
      "dictionaries/names/global.json",
      "dictionaries/names/first/cs.json",
      "dictionaries/names/surnames/cs.json",
      "dictionaries/cities/CZ.json",
      "dictionaries/banks/US.json",
      "dictionaries/courts/US.json",
      "dictionaries/insurance/CZ.json",
      "dictionaries/education/universities-CZ.json",
      "dictionaries/government/ministries-CZ.json",
      "dictionaries/healthcare/hospitals-CZ.json",
      "dictionaries/international/eu-institutions.json",
    ],
  },
  {
    dir: "packages/anonymize/wasm",
    expected: [
      "dist/wasm.d.mts",
      "dist/wasm.mjs",
      "dist/vite.d.mts",
      "dist/vite.mjs",
      "README.md",
      "LICENSE",
      "package.json",
    ],
  },
];

for (const { dir, expected } of PACKAGES) {
  const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  const pack = JSON.parse(packJson)[0];

  if (!pack) {
    console.error(`No pack metadata returned for ${dir}`);
    process.exit(1);
  }

  const files = new Set(pack.files.map((entry) => entry.path));
  const missing = expected.filter((file) => !files.has(file));

  if (missing.length > 0) {
    console.error(`${dir}: missing pack files: ${missing.join(", ")}`);
    process.exit(1);
  }
}
