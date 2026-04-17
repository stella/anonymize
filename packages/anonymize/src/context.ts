import type { UnifiedSearchInstance } from "./build-unified-search";
import type { Entity } from "./types";

/**
 * Build a stable cache key for an entity that survives
 * shallow copies (spread). Uses position + label so the
 * key is identical for the original object and any
 * `{ ...entity }` copy produced by mergeAndDedup.
 */
export const corefKey = (e: Entity): string => `${e.start}:${e.end}:${e.label}`;

/**
 * Compiled RegExp pattern used for coreference
 * definition extraction.
 */
export type DefinitionPattern = {
  pattern: RegExp;
};

/**
 * Cached data for the name corpus detector.
 * Populated by initNameCorpus; consumed by
 * detectNameCorpus and deny-list AC integration.
 */
export type NameCorpusData = {
  firstNames: ReadonlySet<string>;
  surnames: ReadonlySet<string>;
  titleTokens: ReadonlySet<string>;
  excludedWords: ReadonlySet<string>;
  /** Raw arrays exposed for deny-list AC integration. */
  firstNamesList: readonly string[];
  surnamesList: readonly string[];
  titlesList: readonly string[];
  excludedList: readonly string[];
};

/**
 * All cached state for a single pipeline run (or
 * sequence of runs sharing the same config). Replacing
 * module-level singletons with this object enables
 * concurrent pipelines with different configs and
 * simplifies testing.
 *
 * Each field starts null and is populated lazily on
 * first use by the corresponding loader function.
 */
export type PipelineContext = {
  // ── Unified search cache ──────────────────────
  search: UnifiedSearchInstance | null;
  searchKey: string;
  searchPromise: Promise<UnifiedSearchInstance> | null;

  // ── Name corpus ───────────────────────────────
  nameCorpus: NameCorpusData | null;
  nameCorpusPromise: Promise<void> | null;

  // ── Deny-list data sets ───────────────────────
  stopwords: ReadonlySet<string> | null;
  stopwordsPromise: Promise<ReadonlySet<string>> | null;
  allowList: ReadonlySet<string> | null;
  allowListPromise: Promise<ReadonlySet<string>> | null;
  personStopwords: ReadonlySet<string> | null;
  personStopwordsPromise: Promise<ReadonlySet<string>> | null;
  /** First-name exclusions for stopword filtering. */
  firstNameExclusions: ReadonlySet<string> | null;
  firstNameExclusionCorpusLen: number;

  // ── Generic roles (false-positive filter) ─────
  genericRoles: ReadonlySet<string> | null;
  genericRolesPromise: Promise<ReadonlySet<string>> | null;

  // ── Coreference ───────────────────────────────
  corefPatterns: DefinitionPattern[] | null;
  corefPatternsPromise: Promise<DefinitionPattern[]> | null;
  corefLoadAttempted: boolean;
  roleStopSet: ReadonlySet<string> | null;
  roleStopSetPromise: Promise<ReadonlySet<string>> | null;

  // ── Zone classifier ───────────────────────────
  zoneHeadingPatterns: RegExp[] | null;
  zoneSigningPatterns: RegExp[] | null;
  zoneInitPromise: Promise<void> | null;

  // ── Coreference source map ────────────────────
  /**
   * Maps coreference entities to their source entity
   * text. Populated by findCoreferenceSpans, consumed
   * by buildPlaceholderMap for consistent placeholder
   * numbering across aliases and source entities.
   *
   * Keyed by `start:end:label` composite string so
   * lookups survive shallow copies (e.g. from
   * mergeAndDedup's spread operator).
   */
  corefSourceMap: Map<string, string>;
};

/** Create a fresh, empty pipeline context. */
export const createPipelineContext = (): PipelineContext => ({
  search: null,
  searchKey: "",
  searchPromise: null,

  nameCorpus: null,
  nameCorpusPromise: null,

  stopwords: null,
  stopwordsPromise: null,
  allowList: null,
  allowListPromise: null,
  personStopwords: null,
  personStopwordsPromise: null,
  firstNameExclusions: null,
  firstNameExclusionCorpusLen: 0,

  genericRoles: null,
  genericRolesPromise: null,

  corefPatterns: null,
  corefPatternsPromise: null,
  corefLoadAttempted: false,
  roleStopSet: null,
  roleStopSetPromise: null,

  zoneHeadingPatterns: null,
  zoneSigningPatterns: null,
  zoneInitPromise: null,

  corefSourceMap: new Map(),
});

/**
 * Module-level default context. Used when callers
 * don't provide an explicit context, preserving full
 * backward compatibility with the existing API.
 */
export const defaultContext: PipelineContext = createPipelineContext();
