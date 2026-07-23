import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parquetReadObjects } from "hyparquet";

import { parseVerifiedArtifact } from "../verified-artifact";

export const GERMAN_LER_PROVENANCE = {
  repository: "https://huggingface.co/datasets/elenanereiss/german-ler",
  commit: "405b6923dfd2299da3d76a68220ee15a95bc1eab",
  file: "data/test-00000-of-00001.parquet",
  sha256: "78e36e4c297e95d755e2a80c8a98f988efee23c2f27e3dfb8c6c28872a57a7e6",
  license: "CC-BY-4.0",
  split: "test",
} as const;

const MAX_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const EXPECTED_DOCUMENTS = 6_673;
const COARSE_LABEL = /^(?:LIT|LOC|NRM|ORG|PER|REG|RS)$/u;

export type GermanLerSpan = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
};

export type GermanLerDocument = {
  readonly id: string;
  readonly text: string;
  readonly spans: readonly GermanLerSpan[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;

export const parseGermanLerRows = (
  rows: readonly unknown[],
): GermanLerDocument[] => {
  const documents: GermanLerDocument[] = [];
  for (const [rowIndex, value] of rows.entries()) {
    if (!isRecord(value)) {
      throw new Error(`German LER row ${rowIndex} is malformed`);
    }
    const tokens = strings(value["tokens"]);
    const tags = strings(value["coarse-ner"]);
    if (
      tokens === undefined ||
      tags === undefined ||
      tokens.length === 0 ||
      tokens.length !== tags.length ||
      tokens.some((token) => token.length === 0)
    ) {
      throw new Error(`German LER row ${rowIndex} is malformed`);
    }
    const id = `sentence-${rowIndex}`;

    const starts: number[] = [];
    let text = "";
    for (const token of tokens) {
      if (text !== "") text += " ";
      starts.push(text.length);
      text += token;
    }

    const spans: GermanLerSpan[] = [];
    let open: GermanLerSpan | undefined;
    const close = (): void => {
      if (open !== undefined) spans.push(open);
      open = undefined;
    };
    for (const [tokenIndex, tag] of tags.entries()) {
      const token = tokens[tokenIndex];
      const start = starts[tokenIndex];
      if (token === undefined || start === undefined) {
        throw new Error(`German LER row ${rowIndex} is malformed`);
      }
      const end = start + token.length;
      if (tag === "O") {
        close();
        continue;
      }
      const match = /^(B|I)-(.+)$/u.exec(tag);
      const prefix = match?.[1];
      const label = match?.[2];
      if (label === undefined || !COARSE_LABEL.test(label)) {
        throw new Error(`German LER row ${rowIndex} has an invalid IOB2 tag`);
      }
      if (prefix === "B") {
        close();
        open = { start, end, label };
      } else if (prefix === "I" && open?.label === label) {
        open = { ...open, end };
      } else {
        throw new Error(
          `German LER row ${rowIndex} has an invalid IOB2 sequence`,
        );
      }
    }
    close();
    documents.push({ id, text, spans });
  }
  if (documents.length === 0) {
    throw new Error("German LER test corpus is empty");
  }
  return documents;
};

const cachePath = (): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `german-ler-${GERMAN_LER_PROVENANCE.commit}.parquet`,
  );

const verified = (bytes: Uint8Array): boolean =>
  createHash("sha256").update(bytes).digest("hex") ===
  GERMAN_LER_PROVENANCE.sha256;

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error("German LER download exceeds the 2 MiB size limit");
  }
  if (response.body === null) {
    throw new Error("German LER download returned an empty response body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new Error("German LER download exceeds the 2 MiB size limit");
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
    if (!verified(cached))
      throw new Error("cached German LER checksum mismatch");
    return cached;
  } catch {
    const { repository, commit, file } = GERMAN_LER_PROVENANCE;
    const response = await fetch(`${repository}/resolve/${commit}/${file}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `German LER download failed with HTTP ${response.status}`,
      );
    }
    const bytes = await readBounded(response);
    if (!verified(bytes))
      throw new Error("German LER download checksum mismatch");
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

export const loadVerifiedGermanLer = async (): Promise<GermanLerDocument[]> => {
  const bytes = await loadVerifiedBytes();
  return parseVerifiedArtifact({
    bytes,
    expectedSha256: GERMAN_LER_PROVENANCE.sha256,
    name: "German LER test split",
    parse: async (verifiedBytes) => {
      const exactBuffer =
        verifiedBytes.buffer instanceof ArrayBuffer &&
        verifiedBytes.byteOffset === 0 &&
        verifiedBytes.byteLength === verifiedBytes.buffer.byteLength
          ? verifiedBytes.buffer
          : verifiedBytes.slice().buffer;
      const rows = await parquetReadObjects({ file: exactBuffer });
      const documents = parseGermanLerRows(rows);
      if (documents.length !== EXPECTED_DOCUMENTS) {
        throw new Error(
          `expected ${EXPECTED_DOCUMENTS} German LER test documents, got ${documents.length}`,
        );
      }
      return documents;
    },
  });
};
