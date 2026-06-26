#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPipelineContext,
  DEFAULT_NATIVE_PIPELINE_CONFIG,
  prepareNativePipelinePackage,
} from "../dist/index.mjs";
import { loadNativeAnonymizeBinding } from "../dist/native-node.mjs";

const args = parseArgs(process.argv.slice(2));
const outputPath = resolve(args.out ?? "native-pipeline.stlanonpkg");
const compressed = args.raw !== true;
const { config, gazetteerEntries } = await loadPackageInput(args);
const binding = loadNativeAnonymizeBinding();
const packageBytes = await prepareNativePipelinePackage({
  binding,
  config,
  gazetteerEntries,
  context: createPipelineContext(),
  compressed,
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, packageBytes);

console.log(
  JSON.stringify({
    event: "native-pipeline-package",
    outputPath,
    bytes: packageBytes.byteLength,
    compressed,
    nativeVersion: binding.nativePackageVersion(),
  }),
);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    switch (value) {
      case "--config": {
        result.config = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--export": {
        result.exportName = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--out": {
        result.out = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--raw": {
        result.raw = true;
        break;
      }
      case "--default-dictionaries": {
        result.defaultDictionaries = true;
        break;
      }
      case "--help": {
        printHelp();
        process.exit(0);
      }
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }
  return result;
}

function requiredValue(values, index, option) {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function loadPackageInput(options) {
  const input = await loadBasePackageInput(options);
  if (!options.defaultDictionaries || input.config.dictionaries !== undefined) {
    return input;
  }
  return {
    ...input,
    config: {
      ...input.config,
      dictionaries: await loadDefaultDictionaries(),
    },
  };
}

async function loadBasePackageInput(options) {
  if (!options.config) {
    return { config: defaultNativePipelineConfig(), gazetteerEntries: [] };
  }
  const moduleUrl = pathToFileURL(resolve(options.config)).href;
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const loaded = await import(moduleUrl);
  const exportName = options.exportName ?? "default";
  const candidate =
    exportName === "default" ? loaded.default : loaded[exportName];
  if (candidate === undefined) {
    throw new Error(`Config module does not export ${exportName}`);
  }
  const value =
    typeof candidate === "function" ? await candidate() : await candidate;
  if (!value || typeof value !== "object") {
    throw new TypeError("Native package config export must be an object");
  }
  if ("config" in value) {
    return {
      config: value.config,
      gazetteerEntries: value.gazetteerEntries ?? [],
    };
  }
  return { config: value, gazetteerEntries: [] };
}

function defaultNativePipelineConfig() {
  return {
    ...DEFAULT_NATIVE_PIPELINE_CONFIG,
    labels: [...DEFAULT_NATIVE_PIPELINE_CONFIG.labels],
    workspaceId: "native-pipeline-package",
  };
}

async function loadDefaultDictionaries() {
  let loaded;
  try {
    loaded = await import("@stll/anonymize-data/dictionaries");
  } catch (error) {
    throw new Error(
      `--default-dictionaries requires @stll/anonymize-data: ${formatError(error)}`,
    );
  }
  if (typeof loaded.loadDictionaryBundle !== "function") {
    throw new TypeError(
      "@stll/anonymize-data/dictionaries does not export loadDictionaryBundle",
    );
  }
  return loaded.loadDictionaryBundle();
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function printHelp() {
  console.log(`Usage: build-native-pipeline-package [options]

Options:
  --out <path>              Output package path. Defaults to native-pipeline.stlanonpkg.
  --config <path>           ESM module exporting a PipelineConfig or { config, gazetteerEntries }.
  --export <name>           Export name to read from the config module. Defaults to default.
  --default-dictionaries    Load @stll/anonymize-data into configs that do not provide dictionaries.
  --raw                     Write an uncompressed package.
`);
}
