import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadGroundTruth } from "../ground-truth";

export const PERFORMANCE_INPUT_SOURCE = "packages/benchmark/fixtures/en.json";

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

export const performanceInputSourceDigest = (): string =>
  createHash("sha256")
    .update(
      readFileSync(join(import.meta.dir, "..", "..", "fixtures", "en.json")),
    )
    .digest("hex");

export const buildPerformanceInput = async (
  targetBytes: number,
): Promise<{
  readonly text: string;
  readonly sha256: string;
}> => {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  const documents = (await loadGroundTruth()).filter(
    ({ language }) => language === "en",
  );
  if (documents.length === 0) {
    throw new Error("English synthetic performance fixtures are unavailable");
  }
  const seed = documents.map(({ text }) => text).join("\n\n") + "\n\n";
  const seedBytes = encoder.encode(seed);
  const repetitions = Math.ceil(targetBytes / seedBytes.length);
  const bytes = encoder.encode(seed.repeat(repetitions));
  const text = truncateUtf8(bytes, targetBytes);
  const encoded = encoder.encode(text);
  if (encoded.length !== targetBytes) {
    throw new Error("performance input does not match its requested byte size");
  }
  return {
    text,
    sha256: createHash("sha256").update(encoded).digest("hex"),
  };
};
