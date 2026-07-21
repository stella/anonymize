import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TAB_PROVENANCE = {
  repository:
    "https://github.com/NorskRegnesentral/text-anonymization-benchmark",
  commit: "558e09e26d6b36f5f78440074e6a233946d98bd9",
  file: "echr_test.json",
  sha256: "cd0f0f15f84a8739654c7cf30c6be8ce27b051ef73974d39d792a0cb8c846379",
  license: "MIT",
} as const;

export const TAB_SAMPLE_SIZE = 12;
export const TAB_SAMPLE_SEED = "stella-blind-tab-v1";
const TAB_MAX_BYTES = 16 * 1024 * 1024;

export type TabIdentifierType = "DIRECT" | "QUASI" | "NO_MASK";

export type TabMention = {
  readonly entityType: string;
  readonly entityId: string;
  readonly start: number;
  readonly end: number;
  readonly identifierType: TabIdentifierType;
};

export type TabDocument = {
  readonly id: string;
  readonly text: string;
  readonly mentions: readonly TabMention[];
};

type RawMention = {
  readonly entity_type?: unknown;
  readonly entity_id?: unknown;
  readonly start_offset?: unknown;
  readonly end_offset?: unknown;
  readonly span_text?: unknown;
  readonly identifier_type?: unknown;
};

type RawAnnotation = {
  readonly entity_mentions?: unknown;
};

type RawDocument = {
  readonly doc_id?: unknown;
  readonly dataset_type?: unknown;
  readonly text?: unknown;
  readonly annotations?: unknown;
};

const isIdentifierType = (value: unknown): value is TabIdentifierType =>
  value === "DIRECT" || value === "QUASI" || value === "NO_MASK";

const parseMention = (
  raw: RawMention,
  text: string,
  documentId: string,
): TabMention => {
  const { entity_type, entity_id, start_offset, end_offset, identifier_type } =
    raw;
  if (
    typeof entity_type !== "string" ||
    typeof entity_id !== "string" ||
    typeof start_offset !== "number" ||
    typeof end_offset !== "number" ||
    !isIdentifierType(identifier_type) ||
    !Number.isSafeInteger(start_offset) ||
    !Number.isSafeInteger(end_offset) ||
    start_offset < 0 ||
    end_offset <= start_offset ||
    end_offset > text.length
  ) {
    throw new Error(`TAB document ${documentId} contains an invalid mention`);
  }
  if (
    typeof raw.span_text !== "string" ||
    text.slice(start_offset, end_offset) !== raw.span_text
  ) {
    throw new Error(`TAB document ${documentId} contains a stale mention span`);
  }
  return {
    entityType: entity_type,
    entityId: entity_id,
    start: start_offset,
    end: end_offset,
    identifierType: identifier_type,
  };
};

export const parseTabTestCorpus = (value: unknown): TabDocument[] => {
  if (!Array.isArray(value)) {
    throw new Error("TAB corpus must be a JSON array");
  }
  const documents: TabDocument[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = item as RawDocument;
    if (
      typeof raw.doc_id !== "string" ||
      raw.dataset_type !== "test" ||
      typeof raw.text !== "string" ||
      raw.annotations === null ||
      typeof raw.annotations !== "object" ||
      Array.isArray(raw.annotations)
    ) {
      throw new Error("TAB corpus contains a malformed or non-test document");
    }
    if (seen.has(raw.doc_id)) {
      throw new Error(`TAB corpus contains duplicate document ${raw.doc_id}`);
    }
    seen.add(raw.doc_id);

    const annotationEntries = Object.values(
      raw.annotations as Record<string, RawAnnotation>,
    );
    if (annotationEntries.length === 0) {
      throw new Error(`TAB document ${raw.doc_id} has no annotations`);
    }
    const mentions: TabMention[] = [];
    for (const annotation of annotationEntries) {
      if (!Array.isArray(annotation.entity_mentions)) {
        throw new Error(`TAB document ${raw.doc_id} has malformed annotations`);
      }
      for (const mention of annotation.entity_mentions) {
        mentions.push(
          parseMention(mention as RawMention, raw.text, raw.doc_id),
        );
      }
    }
    documents.push({ id: raw.doc_id, text: raw.text, mentions });
  }
  if (documents.length === 0) {
    throw new Error("TAB test corpus is empty");
  }
  return documents;
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const selectBlindSample = (
  documents: readonly TabDocument[],
  size = TAB_SAMPLE_SIZE,
): TabDocument[] => {
  if (!Number.isSafeInteger(size) || size <= 0 || size > documents.length) {
    throw new Error(`invalid TAB blind sample size ${size}`);
  }
  return [...documents]
    .sort((left, right) => {
      const byHash = digest(`${TAB_SAMPLE_SEED}\0${left.id}`).localeCompare(
        digest(`${TAB_SAMPLE_SEED}\0${right.id}`),
      );
      return byHash === 0 ? left.id.localeCompare(right.id) : byHash;
    })
    .slice(0, size)
    .sort((left, right) => left.id.localeCompare(right.id));
};

const cachePath = (): string =>
  join(
    import.meta.dir,
    "..",
    "..",
    ".cache",
    `tab-${TAB_PROVENANCE.commit}-${TAB_PROVENANCE.file}`,
  );

const verifiedBytes = (bytes: Uint8Array): boolean =>
  createHash("sha256").update(bytes).digest("hex") === TAB_PROVENANCE.sha256;

const readBoundedResponse = async (response: Response): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TAB_MAX_BYTES) {
    throw new Error("TAB download exceeds the 16 MiB size limit");
  }
  if (response.body === null) {
    throw new Error("TAB download returned an empty response body");
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > TAB_MAX_BYTES) {
      await reader.cancel();
      throw new Error("TAB download exceeds the 16 MiB size limit");
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

export const loadVerifiedTabTestCorpus = async (): Promise<TabDocument[]> => {
  const target = cachePath();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(target);
  } catch {
    const url = `https://raw.githubusercontent.com/NorskRegnesentral/text-anonymization-benchmark/${TAB_PROVENANCE.commit}/${TAB_PROVENANCE.file}`;
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) {
      throw new Error(`TAB download failed with HTTP ${response.status}`);
    }
    bytes = await readBoundedResponse(response);
    if (!verifiedBytes(bytes)) {
      throw new Error("TAB download checksum mismatch");
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
  }
  if (!verifiedBytes(bytes)) {
    throw new Error("cached TAB corpus checksum mismatch");
  }
  return parseTabTestCorpus(JSON.parse(new TextDecoder().decode(bytes)));
};
