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
import { REGEX_META, REGEX_PATTERN_ENTRIES } from "../src/detectors/regex.ts";
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
  "custom_regex_meta",
  "legal_form_data",
  // regex_meta is compared byte-for-byte by the Rust parity harness.
  // regex_patterns is the FULL array (static + signing + legal-form + trigger
  // tail) once the trigger slice lands.
  "regex_meta",
  "regex_patterns",
  // Slice C2 fields.
  "gazetteer_data",
  "trigger_data",
  "coreference_data",
  "deny_list_data",
  "false_positive_filters",
  "name_corpus_data",
  "name_corpus_mode",
  "literal_patterns",
  "literal_options",
  "literal_patterns_from_deny_list_data",
  "slices",
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

// Custom regex whose label only survives via hotword reclassifyTo expansion:
// requesting "date of birth" expands the search labels to include "date"
// (hotword rule reclassifies "date" -> "date of birth"), so the "date" custom
// regex is not label-filtered even though "date" is not a requested label.
add("custom-regex-hotword-reclassify", {
  ...baseConfig(),
  labels: ["date of birth"],
  enableHotwordRules: true,
  customRegexes: [{ pattern: "DOB-\\d+", label: "date" }],
});

// Regex on, trigger phrases off: exercises the empty year-words branch in
// date_data and, for the regex_patterns prefix check, leaves no trigger tail
// so the Rust static+signing prefix equals the full TypeScript array.
add("regex-only-no-triggers", {
  ...baseConfig(),
  enableTriggerPhrases: false,
  labels: ["date", "address", "monetary amount"],
});

// Legal forms on across multiple content languages. legal_form_data is
// language-independent (its getters union every manifest language), so this
// matches baseline for that field; it stresses signing-clause language scoping
// inside regex_patterns across de/fr/pl.
add("legal-forms-multilang", {
  ...baseConfig(),
  languages: ["de", "fr", "pl"],
});

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

// The static regex table is derived at TypeScript module load from the
// @stll/stdnum validators (`toRegex(validator).source`), so its pattern source
// strings cannot be hand-transcribed in Rust. Emit them here as a versioned,
// generated artifact the Rust assembler embeds and filters by label. This is a
// data artifact (the DATA is derived), while the label filtering, validator
// gating, and signing-pattern assembly stay ported Rust logic. The fixtures
// cross-check it: a stale table makes the regex_meta / regex_patterns parity
// tests fail.
const nativeRegexTablePath = join(
  repoRoot,
  "crates",
  "anonymize-adapter-contract",
  "src",
  "assemble",
  "native-regex-table.json",
);

const toNativeRegexSource = (regex) =>
  regex.ignoreCase ? `(?i:${regex.source})` : regex.source;

// Mirror of build-unified-search.ts `toNativeRegexPattern` for static entries.
const toNativeRegexPattern = (entry) => {
  if (typeof entry === "string") {
    return { kind: "regex", pattern: entry };
  }
  const pattern = { kind: "regex", pattern: entry.pattern };
  if (entry.lazy !== undefined) pattern.lazy = entry.lazy;
  if (entry.prefilterAny !== undefined) {
    pattern.prefilter_any = [...entry.prefilterAny];
  }
  if (entry.prefilterCaseInsensitive !== undefined) {
    pattern.prefilter_case_insensitive = entry.prefilterCaseInsensitive;
  }
  if (entry.prefilterRegex !== undefined) {
    pattern.prefilter_regex = toNativeRegexSource(entry.prefilterRegex);
  }
  if (entry.prefilterWindowBytes !== undefined) {
    pattern.prefilter_window_bytes = entry.prefilterWindowBytes;
  }
  if (entry.preparedArtifactPolicy !== undefined) {
    pattern.prepared_artifact_policy = entry.preparedArtifactPolicy;
  }
  return pattern;
};

const writeNativeRegexTable = () => {
  const table = REGEX_PATTERN_ENTRIES.map((entry, index) => {
    const meta = REGEX_META[index];
    const row = {
      pattern: toNativeRegexPattern(entry),
      label: meta.label,
      score: meta.score,
    };
    if (meta.validatorId !== undefined) row.validatorId = meta.validatorId;
    if (meta.validatorInputKind !== undefined) {
      row.validatorInputKind = meta.validatorInputKind;
    }
    if (meta.minByteLength !== undefined) {
      row.minByteLength = meta.minByteLength;
    }
    return row;
  });
  writeFileSync(nativeRegexTablePath, `${JSON.stringify(table, null, 2)}\n`);
};

const run = async () => {
  writeNativeRegexTable();

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
