#!/usr/bin/env bun
// Capture golden parity fixtures for the Rust stage-1 config assembler.
//
// For each fixture PipelineConfig it runs the TypeScript source of truth
// (buildNativeStaticSearchBundle), writes:
//   - <name>.input.json    : { config, gazetteer } fed to the Rust assembler
//   - <name>.expected.json : the fields slice A implements, in stable key order
// and records an end-to-end package digest in manifest.json. The digest hashes
// the package bytes produced by the existing prepareStaticSearchPackageBytes
// binding (sha256 via node:crypto; blake3 is not exposed to JS), so later
// slices can assert full end-to-end parity once they assemble every field.
//
// The full nativeStaticConfig is intentionally NOT written to disk: it embeds
// large language/deny-list data that is neither needed to verify the implemented
// fields nor appropriate to snapshot. Only the trivial implemented fields land
// in the committed expected files.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildNativeStaticSearchBundle } from "../src/build-unified-search.ts";
import { loadNativeAnonymizeBinding } from "../src/native-node.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const fixturesDir = join(
  repoRoot,
  "crates",
  "anonymize-core",
  "tests",
  "fixtures",
  "assemble",
);
mkdirSync(fixturesDir, { recursive: true });

const IMPLEMENTED_FIELDS = [
  "custom_regex_patterns",
  "allowed_labels",
  "threshold",
  "confidence_boost",
  "regex_options",
  "custom_regex_options",
  "signature_data",
  "monetary_data",
  "date_data",
  "zone_data",
  "address_context_data",
  "address_seed_data",
  "country_data",
  "hotword_data",
];

const TOGGLES = [
  "enableTriggerPhrases",
  "enableRegex",
  "enableLegalForms",
  "enableNameCorpus",
  "enableDenyList",
  "enableGazetteer",
  "enableCountries",
  "enableNer",
  "enableConfidenceBoost",
  "enableCoreference",
  "enableZoneClassification",
  "enableHotwordRules",
];

const baseConfig = () => ({
  threshold: 0.5,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: true,
  enableCountries: true,
  enableNer: true,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableZoneClassification: true,
  enableHotwordRules: true,
  labels: [],
  workspaceId: "ws-fixture",
});

const allOff = () => {
  const config = baseConfig();
  for (const toggle of TOGGLES) config[toggle] = false;
  return config;
};

// Build the ordered fixture list: { name, config, gazetteer? }.
const fixtures = [];
const add = (name, config, gazetteer = []) =>
  fixtures.push({ name, config, gazetteer });

add("baseline-all-on", baseConfig());

// Single-toggle-off matrix.
for (const toggle of TOGGLES) {
  const config = baseConfig();
  config[toggle] = false;
  add(`toggle-off-${toggle}`, config);
}

// Isolate-one-detector-on: everything off except one.
for (const toggle of [
  "enableTriggerPhrases",
  "enableRegex",
  "enableLegalForms",
  "enableNameCorpus",
  "enableDenyList",
  "enableGazetteer",
  "enableCountries",
  "enableCoreference",
]) {
  const config = allOff();
  config[toggle] = true;
  add(`isolate-${toggle}`, config);
}

// Language scopes.
add("language-all", baseConfig());
for (const language of ["cs", "de", "en", "ja"]) {
  add(`language-${language}`, { ...baseConfig(), language });
}
add("language-cs-sk", { ...baseConfig(), languages: ["cs", "sk"] });

// Custom regexes (require enableRegex).
add("custom-regex-basic", {
  ...baseConfig(),
  customRegexes: [
    { pattern: "\\bACME-\\d+\\b", label: "case number", score: 0.9 },
  ],
});
add("custom-regex-prepared-omit", {
  ...baseConfig(),
  customRegexes: [
    { pattern: "secret-\\w+", label: "custom", preparedArtifactPolicy: "omit" },
  ],
});
add("custom-regex-prepared-include", {
  ...baseConfig(),
  customRegexes: [
    {
      pattern: "token-\\w+",
      label: "custom",
      preparedArtifactPolicy: "include",
    },
  ],
});
// Label filter: only "person" allowed; the "organization" regex is dropped.
add("custom-regex-label-filtered", {
  ...baseConfig(),
  labels: ["person"],
  customRegexes: [
    { pattern: "Person-\\d+", label: "person" },
    { pattern: "Org-\\d+", label: "organization" },
  ],
});
// enableRegex off drops all custom regexes.
add("custom-regex-disabled", {
  ...baseConfig(),
  enableRegex: false,
  customRegexes: [{ pattern: "X-\\d+", label: "custom" }],
});

// Custom deny list (require enableDenyList). Boundary-override flips
// canUseGlobalWholeWordLiterals: a value with non-alphanumeric edges.
add("custom-deny-boundary-override", {
  ...baseConfig(),
  customDenyList: [{ value: "@handle", label: "person" }],
});
add("custom-deny-non-override", {
  ...baseConfig(),
  customDenyList: [{ value: "Acme", label: "organization" }],
});

// Gazetteer including a fuzzy (>=4 char) entry.
add("gazetteer-fuzzy", baseConfig(), [
  {
    id: "gaz-1",
    canonical: "Wintermute",
    label: "person",
    variants: ["Winter"],
    workspaceId: "ws-fixture",
    createdAt: 1_700_000_000_000,
    source: "manual",
  },
]);

// Label subset with a nonstandard threshold.
add("labels-and-threshold", {
  ...baseConfig(),
  labels: ["person", "organization", "address"],
  threshold: 0.73,
});

// Confidence boost off in isolation (implemented field).
add("confidence-boost-off", { ...baseConfig(), enableConfidenceBoost: false });

const stableExpected = (config) => {
  const expected = {};
  for (const field of IMPLEMENTED_FIELDS) {
    if (config[field] !== undefined) expected[field] = config[field];
  }
  return expected;
};

const binding = (() => {
  try {
    return loadNativeAnonymizeBinding();
  } catch (error) {
    process.stderr.write(
      `warning: native binding unavailable, digests will be null: ${String(error)}\n`,
    );
    return null;
  }
})();

const packageDigest = (nativeStaticConfig) => {
  if (!binding) return null;
  const configBytes = new TextEncoder().encode(
    JSON.stringify(nativeStaticConfig),
  );
  const packageBytes = binding.prepareStaticSearchPackageBytes(configBytes);
  return createHash("sha256").update(Buffer.from(packageBytes)).digest("hex");
};

// The with-dictionaries fixture injects a tiny, public-safe, hand-crafted
// bundle rather than loadTestDictionaries: the smallest scoped test bundle is
// ~900 KB (Czech city/name data), which the "no large snapshots" convention
// discourages committing and which does not affect any field slice A verifies.
// Later slices consume the injected data; slice A only records its digest.
const tinyDictionaries = () => ({
  firstNames: { cs: ["Jan", "Petr"] },
  surnames: { cs: ["Novak"] },
  denyList: { "courts/CZ": ["Ustavni soud"] },
  denyListMeta: {
    "courts/CZ": { label: "court", category: "Courts", country: "CZ" },
  },
  cities: ["Brno"],
  citiesByCountry: { CZ: ["Brno"] },
});

const run = async () => {
  add("with-test-dictionaries", {
    ...baseConfig(),
    language: "cs",
    dictionaries: tinyDictionaries(),
  });

  const manifest = {
    generatedBy: "packages/anonymize/scripts/capture-assemble-fixtures.mjs",
    source: "buildNativeStaticSearchBundle",
    digest: {
      algorithm: "sha256",
      hashedInput: "prepareStaticSearchPackageBytes(nativeStaticConfig) bytes",
      note: "blake3 is not exposed to JS; sha256 of the end-to-end package bytes.",
    },
    fixtures: [],
  };

  for (const { name, config, gazetteer } of fixtures) {
    const bundle = await buildNativeStaticSearchBundle(config, gazetteer);
    const nativeStaticConfig = bundle.nativeStaticConfig;

    writeFileSync(
      join(fixturesDir, `${name}.input.json`),
      `${JSON.stringify({ config, gazetteer }, null, 2)}\n`,
    );
    writeFileSync(
      join(fixturesDir, `${name}.expected.json`),
      `${JSON.stringify(stableExpected(nativeStaticConfig), null, 2)}\n`,
    );

    let digest = null;
    let digestError = null;
    try {
      digest = packageDigest(nativeStaticConfig);
    } catch (error) {
      digestError = String(error);
    }

    manifest.fixtures.push({
      name,
      packageDigest: digest,
      ...(digestError ? { digestError } : {}),
      hasDictionaries: config.dictionaries !== undefined,
      gazetteerCount: gazetteer.length,
    });
  }

  writeFileSync(
    join(fixturesDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `captured ${fixtures.length} assemble fixtures to ${fixturesDir}\n`,
  );
};

await run();
