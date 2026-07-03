import type { UnifiedSearchInstance } from "./build-unified-search";
import type { Entity } from "./types";

/**
 * Build a stable cache key for an entity that survives
 * shallow copies (spread). Uses position + label so the
 * key is identical for the original object and any
 * `{ ...entity }` copy produced by mergeAndDedup.
 *
 * @deprecated No longer used internally: coref alias
 *   links travel on the entities themselves
 *   (`corefSourceText`). Kept for API compatibility.
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
 * A single in-flight-or-resolved keyed load stored on the context.
 *
 * Concurrent callers with the same `key` share one `promise`; a caller with a
 * different key atomically REPLACES the record. This lets loaders detect that
 * they are outdated: a promise that resolves after its record was replaced must
 * NOT write shared derived state (see initNameCorpus / loadStopwords), because a
 * newer config now owns that state. The resolved value still travels on the
 * promise, so each caller reads its own config's result even after the shared
 * slot has moved on.
 */
export type KeyedLoad<T> = {
  key: string;
  promise: Promise<T>;
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
  /** Abbreviation-style titles whose trailing dot is
   *  part of the title, not a sentence boundary.
   *  Contains the lowercase, dot-stripped form
   *  (e.g., "dr", "smt", "atty"). */
  titleAbbreviations: ReadonlySet<string>;
  excludedWords: ReadonlySet<string>;
  /** Lowercased common English words. A name chain whose
   *  every token is a common word (e.g. "Loan Documents",
   *  where "Loan" coincides with a Vietnamese given name)
   *  is treated as a common-word phrase, not a person. */
  commonWords: ReadonlySet<string>;
  /** Non-Western name tokens merged across all locales. */
  nonWesternNames: ReadonlySet<string>;
  /** All-caps acronyms excluded from name detection. */
  excludedAllCaps: ReadonlySet<string>;
  /** Raw arrays exposed for deny-list AC integration. */
  firstNamesList: readonly string[];
  surnamesList: readonly string[];
  titlesList: readonly string[];
  excludedList: readonly string[];
  nonWesternNamesList: readonly string[];
  excludedAllCapsList: readonly string[];
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
  nativePipelinePackage: Uint8Array | null;
  nativePipelinePackageKey: string;
  nativePipelinePackagePromise: Promise<Uint8Array> | null;

  // ── Name corpus ───────────────────────────────
  /** Resolved corpus for the most recently loaded config. Convenience slot
   *  for the legacy sync accessors and TS detection path; the authoritative
   *  per-config value travels on `nameCorpusLoad.promise`. */
  nameCorpus: NameCorpusData | null;
  /** Atomic keyed load. Keyed by dictionary identity + selected languages so
   *  two configs sharing one context each build their own corpus and an
   *  outdated load cannot clobber a newer one. */
  nameCorpusLoad: KeyedLoad<NameCorpusData | null> | null;

  // ── Deny-list data sets ───────────────────────
  /** Resolved stopwords for the most recently loaded config (convenience
   *  slot; per-config value travels on `stopwordsLoad.promise`). */
  stopwords: ReadonlySet<string> | null;
  /** Atomic keyed load. Keyed by the corpus identity (not its size): the
   *  filtered set excludes corpus given names so they stay person-detectable,
   *  and two corpora with equal counts must not alias. */
  stopwordsLoad: KeyedLoad<ReadonlySet<string>> | null;
  allowList: ReadonlySet<string> | null;
  allowListPromise: Promise<ReadonlySet<string>> | null;
  personStopwords: ReadonlySet<string> | null;
  personStopwordsPromise: Promise<ReadonlySet<string>> | null;
  definedTermHeads: ReadonlySet<string> | null;
  definedTermHeadsPromise: Promise<ReadonlySet<string>> | null;
  addressStopwords: ReadonlySet<string> | null;
  addressStopwordsPromise: Promise<ReadonlySet<string>> | null;

  // ── Generic roles (false-positive filter) ─────
  genericRoles: ReadonlySet<string> | null;
  genericRolesPromise: Promise<ReadonlySet<string>> | null;

  // ── Coreference ───────────────────────────────
  corefPatterns: DefinitionPattern[] | null;
  corefPatternsKey: string;
  corefPatternsPromise: Promise<DefinitionPattern[]> | null;
  corefLoadAttempted: boolean;
  roleStopSet: ReadonlySet<string> | null;
  roleStopSetPromise: Promise<ReadonlySet<string>> | null;

  // ── Zone classifier ───────────────────────────
  zoneHeadingPatterns: RegExp[] | null;
  zoneSigningPatterns: RegExp[] | null;
  zoneInitPromise: Promise<void> | null;
};

/** Create a fresh, empty pipeline context. */
export const createPipelineContext = (): PipelineContext => ({
  search: null,
  searchKey: "",
  searchPromise: null,
  nativePipelinePackage: null,
  nativePipelinePackageKey: "",
  nativePipelinePackagePromise: null,

  nameCorpus: null,
  nameCorpusLoad: null,

  stopwords: null,
  stopwordsLoad: null,
  allowList: null,
  allowListPromise: null,
  personStopwords: null,
  personStopwordsPromise: null,
  definedTermHeads: null,
  definedTermHeadsPromise: null,
  addressStopwords: null,
  addressStopwordsPromise: null,

  genericRoles: null,
  genericRolesPromise: null,

  corefPatterns: null,
  corefPatternsKey: "",
  corefPatternsPromise: null,
  corefLoadAttempted: false,
  roleStopSet: null,
  roleStopSetPromise: null,

  zoneHeadingPatterns: null,
  zoneSigningPatterns: null,
  zoneInitPromise: null,
});

/**
 * Module-level default context. Used when callers
 * don't provide an explicit context, preserving full
 * backward compatibility with the existing API.
 */
export const defaultContext: PipelineContext = createPipelineContext();
