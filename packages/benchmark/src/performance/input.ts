import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadGroundTruth } from "../ground-truth";

export const PERFORMANCE_INPUT_SOURCE =
  "versioned performance scenarios and packages/benchmark/fixtures/*.json";

export const PERFORMANCE_SCENARIO_SCHEMA_VERSION = 1 as const;

export const PERFORMANCE_SCENARIO_IDS = [
  "fixture-mixed",
  "negative-prose",
  "sparse-entities",
  "dense-entities",
] as const;

export type PerformanceScenarioId = (typeof PERFORMANCE_SCENARIO_IDS)[number];

export type PerformanceScenario = {
  readonly type: "performance-input-scenario";
  readonly schemaVersion: typeof PERFORMANCE_SCENARIO_SCHEMA_VERSION;
  readonly id: PerformanceScenarioId;
};

export const DEFAULT_PERFORMANCE_SCENARIO_ID = "fixture-mixed" as const;

const NEGATIVE_PROSE_SEED =
  "The written terms apply to each section. Review the general policy before approval. " +
  "A later paragraph explains the ordinary process and the available remedy.\n";
const SPARSE_ENTITY_MARKER =
  "Contact sparse.person@example.test for assistance.\n";
const SPARSE_BLOCK_BYTES = 16 * 1024;
const DENSE_ENTITY_SEED =
  "Email dense.person@example.test or call +1 202 555 0147. " +
  "Reference account GB82 WEST 1234 5698 7654 32.\n";

const encoder = new TextEncoder();

const truncateUtf8 = (bytes: Uint8Array, targetBytes: number): string => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = targetBytes;
  while (end > 0) {
    try {
      const prefix = decoder.decode(bytes.subarray(0, end));
      return prefix + " ".repeat(targetBytes - end);
    } catch {
      end -= 1;
    }
  }
  throw new Error("could not truncate performance input at a UTF-8 boundary");
};

export const performanceInputSourceDigest = (): string => {
  const fixtures = join(import.meta.dir, "..", "..", "fixtures");
  const hash = createHash("sha256");
  for (const file of readdirSync(fixtures)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(fixtures, file)));
  }
  hash.update(`${PERFORMANCE_SCENARIO_SCHEMA_VERSION}\0`);
  for (const scenario of PERFORMANCE_SCENARIO_IDS) hash.update(`${scenario}\0`);
  hash.update(NEGATIVE_PROSE_SEED);
  hash.update(SPARSE_ENTITY_MARKER);
  hash.update(`${SPARSE_BLOCK_BYTES}\0`);
  hash.update(DENSE_ENTITY_SEED);
  return hash.digest("hex");
};

export const performanceScenario = (
  id: PerformanceScenarioId,
): PerformanceScenario => ({
  type: "performance-input-scenario",
  schemaVersion: PERFORMANCE_SCENARIO_SCHEMA_VERSION,
  id,
});

export const parsePerformanceScenarioId = (
  value: string,
): PerformanceScenarioId => {
  const id = PERFORMANCE_SCENARIO_IDS.find((candidate) => candidate === value);
  if (id === undefined) {
    throw new Error(
      `unknown performance scenario ${value}; expected ${PERFORMANCE_SCENARIO_IDS.join(", ")}`,
    );
  }
  return id;
};

const repeatToUtf8Bytes = (seed: string, targetBytes: number): string => {
  const seedBytes = encoder.encode(seed);
  const repetitions = Math.ceil(targetBytes / seedBytes.length);
  return truncateUtf8(encoder.encode(seed.repeat(repetitions)), targetBytes);
};

const sparseEntitySeed = (): string => {
  const remainingBytes =
    SPARSE_BLOCK_BYTES - encoder.encode(SPARSE_ENTITY_MARKER).length;
  if (remainingBytes <= 0) {
    throw new Error("sparse performance marker exceeds its block size");
  }
  return (
    SPARSE_ENTITY_MARKER +
    repeatToUtf8Bytes(NEGATIVE_PROSE_SEED, remainingBytes)
  );
};

const scenarioSeed = async (id: PerformanceScenarioId): Promise<string> => {
  if (id === "negative-prose") return NEGATIVE_PROSE_SEED;
  if (id === "sparse-entities") return sparseEntitySeed();
  if (id === "dense-entities") return DENSE_ENTITY_SEED;

  const documents = (await loadGroundTruth()).filter(
    ({ language }) => language === "en",
  );
  if (documents.length === 0) {
    throw new Error("English synthetic performance fixtures are unavailable");
  }
  return documents.map(({ text }) => text).join("\n\n") + "\n\n";
};

export const buildPerformanceInput = async (
  targetBytes: number,
  scenarioId: PerformanceScenarioId = DEFAULT_PERFORMANCE_SCENARIO_ID,
): Promise<{
  readonly text: string;
  readonly sha256: string;
  readonly scenario: PerformanceScenario;
}> => {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  const text = repeatToUtf8Bytes(await scenarioSeed(scenarioId), targetBytes);
  const encoded = encoder.encode(text);
  if (encoded.length !== targetBytes) {
    throw new Error("performance input does not match its requested byte size");
  }
  return {
    text,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    scenario: performanceScenario(scenarioId),
  };
};
