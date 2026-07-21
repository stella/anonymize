import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parquetReadObjects } from "hyparquet";

export const REDACTIONBENCH_PROVENANCE = {
  repository: "https://huggingface.co/datasets/RedactionBench/RedactionBench",
  commit: "d45e9cec89bc49c69355e252fec29cc0229982f6",
  file: "data/test-00000-of-00001.parquet",
  sha256: "17ea0b577344917ce6e265667dd833cbf18e4f2cc07aa230d55f1e151219f5f0",
  license: "CC-BY-4.0",
  split: "test",
} as const;

const MAX_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type RedactionBenchLabel = "mandatory" | "contextual";

export type RedactionBenchSpan = {
  readonly start: number;
  readonly end: number;
  readonly label: RedactionBenchLabel;
};

export type RedactionBenchDocument = {
  readonly id: string;
  readonly text: string;
  readonly category: string;
  readonly genre: string;
  readonly synthetic: boolean;
  readonly sourceUrl: string | null;
  readonly spans: readonly RedactionBenchSpan[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const safeOffset = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (
    typeof value === "bigint" &&
    value >= 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
};

type ParseSpanParams = {
  readonly value: unknown;
  readonly text: string;
  readonly documentId: string;
};

const parseSpan = ({
  value,
  text,
  documentId,
}: ParseSpanParams): RedactionBenchSpan => {
  if (!isRecord(value)) {
    throw new Error(`${documentId} contains a malformed span`);
  }
  const start = safeOffset(value["start"]);
  const end = safeOffset(value["end"]);
  const label = value["label"];
  if (
    start === null ||
    end === null ||
    (label !== "mandatory" && label !== "contextual") ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    throw new Error(`${documentId} contains an invalid span`);
  }
  return { start, end, label };
};

export const parseRedactionBenchRows = (
  rows: readonly unknown[],
): RedactionBenchDocument[] => {
  const documents: RedactionBenchDocument[] = [];
  const ids = new Set<string>();
  for (const [index, value] of rows.entries()) {
    if (!isRecord(value)) {
      throw new Error(`RedactionBench row ${index} is malformed`);
    }
    const text = value["raw_text"];
    const category = value["category"];
    const genre = value["genre"];
    const synthetic = value["is_synthetic"];
    const sourceUrl = value["original_document_url"];
    const rawSpans = value["spans"];
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      typeof category !== "string" ||
      typeof genre !== "string" ||
      typeof synthetic !== "boolean" ||
      (sourceUrl !== null && typeof sourceUrl !== "string") ||
      !Array.isArray(rawSpans)
    ) {
      throw new Error(`RedactionBench row ${index} is malformed`);
    }
    const id = `${category}/${genre}`;
    if (ids.has(id)) {
      throw new Error(`RedactionBench contains duplicate document ${id}`);
    }
    ids.add(id);
    documents.push({
      id,
      text,
      category,
      genre,
      synthetic,
      sourceUrl,
      spans: rawSpans.map((spanValue) =>
        parseSpan({ value: spanValue, text, documentId: id }),
      ),
    });
  }
  if (documents.length === 0) {
    throw new Error("RedactionBench test corpus is empty");
  }
  return documents;
};

const cachePath = (): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `redactionbench-${REDACTIONBENCH_PROVENANCE.commit}.parquet`,
  );

const verified = (bytes: Uint8Array): boolean =>
  createHash("sha256").update(bytes).digest("hex") ===
  REDACTIONBENCH_PROVENANCE.sha256;

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error("RedactionBench download exceeds the 4 MiB size limit");
  }
  if (response.body === null) {
    throw new Error("RedactionBench download returned an empty response body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new Error("RedactionBench download exceeds the 4 MiB size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const loadVerifiedBytes = async (): Promise<Uint8Array> => {
  const target = cachePath();
  try {
    const cached = await readFile(target);
    if (!verified(cached)) {
      throw new Error("cached RedactionBench checksum mismatch");
    }
    return cached;
  } catch {
    const { repository, commit, file } = REDACTIONBENCH_PROVENANCE;
    const response = await fetch(`${repository}/resolve/${commit}/${file}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `RedactionBench download failed with HTTP ${response.status}`,
      );
    }
    const bytes = await readBounded(response);
    if (!verified(bytes)) {
      throw new Error("RedactionBench download checksum mismatch");
    }
    await mkdir(dirname(target), { recursive: true });
    const staged = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(staged, bytes);
    try {
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    return bytes;
  }
};

export const loadVerifiedRedactionBench = async (): Promise<
  RedactionBenchDocument[]
> => {
  const bytes = await loadVerifiedBytes();
  const exactBuffer =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const rows = await parquetReadObjects({ file: exactBuffer });
  return parseRedactionBenchRows(rows);
};
