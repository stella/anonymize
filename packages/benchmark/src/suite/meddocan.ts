import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { unzipSync } from "fflate";

import { parseVerifiedArtifact } from "../verified-artifact";

export const MEDDOCAN_PROVENANCE = {
  doi: "10.5281/zenodo.4279323",
  repository: "https://zenodo.org/records/4279323",
  version: "4279323",
  file: "meddocan.zip",
  url: "https://zenodo.org/api/records/4279323/files/meddocan.zip/content",
  sha256: "d0e4708b58689bc1440ede6f89e017e58d667827d927827622d73810cd68eac3",
  license: "CC-BY-4.0",
  split: "test",
} as const;

const MAX_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const decoder = new TextDecoder();
// MEDDOCAN offsets count the UTF-8 BOM present in some source documents.
const documentDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export type MeddocanSpan = {
  readonly start: number;
  readonly end: number;
  readonly label: string;
};

export type MeddocanDocument = {
  readonly id: string;
  readonly text: string;
  readonly spans: readonly MeddocanSpan[];
};

const parseAnnotations = (
  annotation: string,
  text: string,
  id: string,
): MeddocanSpan[] =>
  annotation
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [annotationId, definition, annotatedText] = line.split("\t");
      const match = /^(\S+) (\d+) (\d+)$/u.exec(definition ?? "");
      if (annotationId === undefined || match === null) {
        throw new Error(`${id} contains an unsupported BRAT annotation`);
      }
      const start = Number(match[2]);
      const end = Number(match[3]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > text.length ||
        text.slice(start, end) !== annotatedText
      ) {
        throw new Error(
          `${id} contains a stale BRAT annotation ${annotationId}`,
        );
      }
      return { label: match[1] ?? "", start, end };
    });

export const parseMeddocanArchive = (
  bytes: Uint8Array,
  expectedDocuments = 250,
): MeddocanDocument[] => {
  const archive = unzipSync(bytes);
  const prefix = "meddocan/test/brat/";
  const documents: MeddocanDocument[] = [];
  for (const path of Object.keys(archive).sort()) {
    if (!path.startsWith(prefix) || !path.endsWith(".txt")) continue;
    const id = path.slice(prefix.length, -4);
    const textBytes = archive[path];
    const annotationBytes = archive[`${prefix}${id}.ann`];
    if (textBytes === undefined || annotationBytes === undefined) {
      throw new Error(`MEDDOCAN document ${id} is missing its BRAT pair`);
    }
    const text = documentDecoder.decode(textBytes);
    documents.push({
      id,
      text,
      spans: parseAnnotations(decoder.decode(annotationBytes), text, id),
    });
  }
  if (documents.length !== expectedDocuments) {
    throw new Error(
      `expected ${expectedDocuments} MEDDOCAN test documents, got ${documents.length}`,
    );
  }
  return documents;
};

const cachePath = (): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `meddocan-${MEDDOCAN_PROVENANCE.sha256}.zip`,
  );

const verified = (bytes: Uint8Array): boolean =>
  createHash("sha256").update(bytes).digest("hex") ===
  MEDDOCAN_PROVENANCE.sha256;

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error("MEDDOCAN download exceeds the 16 MiB size limit");
  }
  if (response.body === null)
    throw new Error("MEDDOCAN returned an empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new Error("MEDDOCAN download exceeds the 16 MiB size limit");
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
    if (!verified(cached)) throw new Error("cached MEDDOCAN checksum mismatch");
    return cached;
  } catch {
    const response = await fetch(MEDDOCAN_PROVENANCE.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`MEDDOCAN download failed with HTTP ${response.status}`);
    }
    const bytes = await readBounded(response);
    if (!verified(bytes))
      throw new Error("MEDDOCAN download checksum mismatch");
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

export const loadVerifiedMeddocan = async (): Promise<MeddocanDocument[]> =>
  parseVerifiedArtifact({
    bytes: await loadVerifiedBytes(),
    expectedSha256: MEDDOCAN_PROVENANCE.sha256,
    name: "MEDDOCAN test split",
    parse: (bytes) => parseMeddocanArchive(bytes),
  });
