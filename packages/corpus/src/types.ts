export const CORPUS_SOURCES = ["edgar", "case-law"] as const;

export type CorpusSource = (typeof CORPUS_SOURCES)[number];

export type ManifestEntry = {
  /**
   * Stable document id: EDGAR `accession:filename`,
   * or a citation identifier (ECLI) for case law.
   */
  id: string;
  source: CorpusSource;
  /** Re-fetch location; null for manually added documents. */
  url: string | null;
  /** Search query that surfaced the document; null when added manually. */
  query: string | null;
  /** ISO 639-1 language of the document text. */
  language: string;
  /** SHA-256 (hex) of the stored plain text. */
  sha256: string;
  /** ISO 8601 fetch timestamp. */
  fetchedAt: string;
};

export type Manifest = {
  entries: ManifestEntry[];
};

export type SkipEntry = {
  /** Document id (EDGAR `accession:filename`) that was skipped. */
  id: string;
  /** Why the document was skipped, e.g. a size bound it violated. */
  reason: string;
};

/**
 * Documents the fetcher intentionally did not store, so repeated
 * searches do not re-download them on every run.
 */
export type SkipList = {
  entries: SkipEntry[];
};

export type RunEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
};

export type RunDocument = {
  docId: string;
  sha256: string;
  language: string;
  entityCount: number;
  entities: RunEntity[];
};

export type RunSummary = {
  createdAt: string;
  gitSha: string;
  documentCount: number;
  entityCount: number;
};

export const SPAN_VERDICTS = ["tp", "fp", "fn"] as const;

/**
 * tp: correctly detected. fp: detected but not PII.
 * fn: PII the pipeline misses at this span.
 */
export type SpanVerdict = (typeof SPAN_VERDICTS)[number];

export type VerdictSpan = {
  start: number;
  end: number;
  /** Verbatim text at [start, end); must match the document exactly. */
  value: string;
  label: string;
  verdict: SpanVerdict;
  note?: string;
};

export type VerdictsFile = {
  docId: string;
  sha256: string;
  spans: VerdictSpan[];
};
