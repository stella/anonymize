import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";
import type { PipelineContext, NameCorpusData } from "../context";
import { defaultContext } from "../context";
import { ALL_UPPER_RE, UPPER_START_RE, isSentenceStart } from "../util/text";

// ── Name corpus ──────────────────────────────────────
// Per-language first names and surnames loaded from
// Wikidata-sourced dictionaries from @stll/anonymize-data (optional),
// plus legacy config/names-*.json for backwards compat.
// Merged at init time across all configured languages.

// ── Accessors (read from context) ────────────────────

const getCorpus = (ctx: PipelineContext): NameCorpusData | null =>
  ctx.nameCorpus;

// Exported accessors for deny-list.ts AC integration.
export const getNameCorpusFirstNames = (
  ctx: PipelineContext = defaultContext,
): readonly string[] => ctx.nameCorpus?.firstNamesList ?? [];
export const getNameCorpusSurnames = (
  ctx: PipelineContext = defaultContext,
): readonly string[] => ctx.nameCorpus?.surnamesList ?? [];
export const getNameCorpusTitles = (
  ctx: PipelineContext = defaultContext,
): readonly string[] => ctx.nameCorpus?.titlesList ?? [];
export const getNameCorpusExcluded = (
  ctx: PipelineContext = defaultContext,
): readonly string[] => ctx.nameCorpus?.excludedList ?? [];

/**
 * Languages with per-language first/surname
 * dictionaries from @stll/anonymize-data (optional).
 */
const NAME_LANGUAGES = [
  "cs",
  "sk",
  "de",
  "pl",
  "hu",
  "ro",
  "fr",
  "es",
  "it",
  "en",
  "sv",
] as const;

type JsonArrayModule = {
  default: readonly string[];
};

/**
 * Try importing a JSON module; return empty array
 * if not found.
 */
const tryImportArray = async (path: string): Promise<readonly string[]> => {
  try {
    const mod = (await import(path)) as JsonArrayModule;
    return mod.default;
  } catch {
    return [];
  }
};

/**
 * Load name corpus data from per-language dictionary
 * files and legacy config files. Merges all sources.
 *
 * Safe to call multiple times; only loads once per
 * context. Must be called before detectNameCorpus or
 * the getNameCorpus*() accessors are used.
 */
export const initNameCorpus = (
  ctx: PipelineContext = defaultContext,
): Promise<void> => {
  if (ctx.nameCorpusPromise) return ctx.nameCorpusPromise;
  const promise = (async () => {
    try {
      // Load legacy config files (backwards compat)
      const [legacyFirstMod, legacySurnameMod, titleMod, exclusionMod] =
        await Promise.all([
          import("../data/names-first.json") as Promise<{
            default: { names: string[] };
          }>,
          import("../data/names-surnames.json") as Promise<{
            default: { names: string[] };
          }>,
          import("../data/names-title-tokens.json") as Promise<{
            default: { tokens: string[] };
          }>,
          import("../data/names-exclusions.json") as Promise<{
            default: { words: string[] };
          }>,
        ]);

      // Load per-language dictionaries in parallel
      const firstImports = NAME_LANGUAGES.map((lang) =>
        tryImportArray(
          `@stll/anonymize-data/dictionaries/names/first/${lang}.json`,
        ),
      );
      const surnameImports = NAME_LANGUAGES.map((lang) =>
        tryImportArray(
          `@stll/anonymize-data/dictionaries/names/surnames/${lang}.json`,
        ),
      );

      const [firstResults, surnameResults] = await Promise.all([
        Promise.all(firstImports),
        Promise.all(surnameImports),
      ]);

      // Merge: legacy config + all per-language files
      const firstNames: string[] = [...legacyFirstMod.default.names];
      for (const names of firstResults) {
        for (const name of names) {
          firstNames.push(name);
        }
      }

      const surnames: string[] = [...legacySurnameMod.default.names];
      for (const names of surnameResults) {
        for (const name of names) {
          surnames.push(name);
        }
      }

      // Deduplicate (preserve first occurrence)
      const dedup = (arr: string[]): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const item of arr) {
          if (seen.has(item)) continue;
          seen.add(item);
          result.push(item);
        }
        return result;
      };

      const dedupFirst = dedup(firstNames);
      const dedupSurnames = dedup(surnames);
      const titles = titleMod.default.tokens;
      const exclusions = exclusionMod.default.words;

      ctx.nameCorpus = {
        firstNames: Object.freeze(new Set(dedupFirst)),
        surnames: Object.freeze(new Set(dedupSurnames)),
        titleTokens: Object.freeze(new Set(titles)),
        excludedWords: Object.freeze(new Set(exclusions)),
        firstNamesList: Object.freeze(dedupFirst),
        surnamesList: Object.freeze(dedupSurnames),
        titlesList: Object.freeze(titles),
        excludedList: Object.freeze(exclusions),
      };
    } catch (err) {
      // Reset so the next call retries the load rather
      // than returning this (already-resolved) failed
      // promise. Current awaiters still get a resolved
      // (not rejected) Promise; ctx.nameCorpus stays null.
      ctx.nameCorpusPromise = null;
      console.warn(
        "[anonymize] Failed to load name corpus JSON" +
          " — name detection disabled:",
        err,
      );
    }
  })();
  ctx.nameCorpusPromise = promise;
  return promise;
};

// ── Czech/Slovak suffix stripping ────────────────────
// Case suffixes commonly appended to names in declined
// Czech/Slovak text. Ordered longest-first.

const INFLECTION_SUFFIXES = [
  "ovi", // dative
  "em", // instrumental
  "om", // instrumental (some stems)
  "ou", // instrumental feminine
  "é", // dative/locative feminine
  "a", // genitive
  "u", // accusative/locative
] as const;

/**
 * Strip common Czech/Slovak case suffixes from a token.
 * Returns candidate base forms if stripping produces a
 * plausible name (capitalised, length >= 3).
 *
 * For the "-ou" instrumental feminine suffix, also yields
 * base + "a" (e.g., "Editou" → "Edit" and "Edita")
 * because Czech feminine names decline -a → -ou.
 */
const stripInflection = (token: string): string[] => {
  const candidates: string[] = [];
  for (const suffix of INFLECTION_SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const base = token.slice(0, -suffix.length);
      if (/^\p{Lu}/u.test(base)) {
        candidates.push(base);
        // Czech feminine: -a → -ou (instrumental),
        // -a → -é (dative/locative), -a → -u (accusative)
        if (suffix === "ou" || suffix === "é" || suffix === "u") {
          candidates.push(`${base}a`);
        }
        // Czech feminine: -a → -ovi is not valid, but
        // -e → -em is (e.g., "Kalhousem" → "Kalhous")
        // which is already handled by stripping "em".
      }
    }
  }
  return candidates;
};

// ── Token types ──────────────────────────────────────

const TOKEN_TYPE = {
  NAME: "name",
  SURNAME: "surname",
  TITLE: "title",
  ABBREVIATION: "abbreviation",
  CAPITALIZED: "capitalized",
  OTHER: "other",
} as const;

type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE];

type ClassifiedToken = {
  text: string;
  type: TokenType;
  start: number;
  end: number;
};

const PERSON_CHAIN_BREAK_RE = /[!?;:]/u;

const isInitialContinuationGap = (text: string, gap: string): boolean =>
  (/^\p{Lu}$/u.test(text) && /^\.[^\S\n]{1,2}$/u.test(gap)) ||
  /^[^\S\n]{1,2}(?:\p{Lu}\.[^\S\n]{1,2})+$/u.test(gap);

// ── Helpers ──────────────────────────────────────────

/**
 * Check if a token is in the first-name set, either
 * directly or after stripping Czech/Slovak inflection.
 */
const isFirstNameToken = (token: string, corpus: NameCorpusData): boolean => {
  if (corpus.firstNames.has(token)) {
    return true;
  }
  return stripInflection(token).some((b) => corpus.firstNames.has(b));
};

/**
 * Check if a token is in the surname set, either
 * directly or after stripping Czech/Slovak inflection.
 */
const isSurnameToken = (token: string, corpus: NameCorpusData): boolean => {
  if (corpus.surnames.has(token)) {
    return true;
  }
  return stripInflection(token).some((b) => corpus.surnames.has(b));
};

/**
 * Check if a token looks like a single-letter
 * abbreviation: "J.", "M.", etc.
 */
const isAbbreviation = (token: string): boolean =>
  token.length === 2 && /^\p{Lu}$/u.test(token[0] ?? "") && token[1] === ".";

// ── Word segmentation ────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, {
  granularity: "word",
});

type WordSegment = {
  text: string;
  start: number;
  end: number;
};

/**
 * Split text into word segments using Intl.Segmenter.
 * Only returns segments flagged as words.
 */
const segmentWords = (fullText: string): WordSegment[] => {
  const words: WordSegment[] = [];
  for (const seg of segmenter.segment(fullText)) {
    if (seg.isWordLike) {
      words.push({
        text: seg.segment,
        start: seg.index,
        end: seg.index + seg.segment.length,
      });
    }
  }
  return words;
};

// ── Helpers for chain scoring ────────────────────────

/** NAME or SURNAME — both represent corpus-matched tokens */
const isCorpusMatch = (type: TokenType): boolean =>
  type === TOKEN_TYPE.NAME || type === TOKEN_TYPE.SURNAME;

// ── Token classification ─────────────────────────────

const classifyToken = (
  word: WordSegment,
  corpus: NameCorpusData,
): ClassifiedToken => {
  const { text, start, end } = word;
  const lower = text.toLowerCase();

  // Strip trailing period for title check (e.g., "Ing.")
  const stripped = text.endsWith(".") ? text.slice(0, -1).toLowerCase() : lower;

  if (corpus.titleTokens.has(stripped)) {
    return { text, type: TOKEN_TYPE.TITLE, start, end };
  }

  if (isAbbreviation(text)) {
    return {
      text,
      type: TOKEN_TYPE.ABBREVIATION,
      start,
      end,
    };
  }

  // Skip excluded words
  if (corpus.excludedWords.has(lower)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Minimum length 3
  if (text.length < 3) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Skip all-uppercase tokens > 3 chars (likely acronyms)
  if (text.length > 3 && ALL_UPPER_RE.test(text)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Must start with uppercase
  if (!UPPER_START_RE.test(text)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  if (isFirstNameToken(text, corpus)) {
    return { text, type: TOKEN_TYPE.NAME, start, end };
  }

  if (isSurnameToken(text, corpus)) {
    return { text, type: TOKEN_TYPE.SURNAME, start, end };
  }

  // Capitalised word (not in corpus but starts uppercase)
  return {
    text,
    type: TOKEN_TYPE.CAPITALIZED,
    start,
    end,
  };
};

// ── Chain assembly ───────────────────────────────────

/**
 * Detect person names by looking up tokens against the
 * name corpus, then chaining adjacent name-like tokens.
 *
 * Requires initNameCorpus() to have been called first.
 * If not initialized, returns an empty array.
 *
 * Scoring:
 *   TITLE + NAME/SURNAME       → 0.95
 *   NAME + NAME/SURNAME        → 0.9
 *   SURNAME + NAME/SURNAME     → 0.9
 *   NAME + CAPITALIZED         → 0.7
 *   ABBREVIATION + NAME        → 0.7
 *   Standalone NAME            → 0.5 (low confidence)
 *   Standalone SURNAME         → skip (too ambiguous)
 */
export const detectNameCorpus = (
  fullText: string,
  ctx: PipelineContext = defaultContext,
): Entity[] => {
  const corpus = getCorpus(ctx);
  if (!corpus) {
    return [];
  }

  const words = segmentWords(fullText);
  const tokens = words.map((w) => classifyToken(w, corpus));
  const entities: Entity[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) {
      continue;
    }

    const token = tokens[i];
    if (!token) {
      continue;
    }

    // Only start chains from TITLE, NAME, SURNAME,
    // or ABBREVIATION
    if (
      token.type !== TOKEN_TYPE.TITLE &&
      token.type !== TOKEN_TYPE.NAME &&
      token.type !== TOKEN_TYPE.SURNAME &&
      token.type !== TOKEN_TYPE.ABBREVIATION
    ) {
      continue;
    }

    // Build a chain of adjacent relevant tokens.
    // Max 5 tokens to prevent merging independent names
    // (e.g., "Jan Novák Pavel Moc" should be two entities).
    const MAX_CHAIN = 5;
    const chain: ClassifiedToken[] = [token];
    let j = i + 1;

    while (j < tokens.length && chain.length < MAX_CHAIN) {
      const next = tokens[j];
      if (!next) {
        break;
      }

      // Break chain if there's a newline between tokens
      const prev = chain.at(-1);
      if (prev) {
        const gap = fullText.slice(prev.end, next.start);
        const breaksOnPeriod =
          gap.includes(".") && !isInitialContinuationGap(prev.text, gap);
        if (
          gap.includes("\n") ||
          PERSON_CHAIN_BREAK_RE.test(gap) ||
          breaksOnPeriod
        ) {
          break;
        }
      }

      // Only chain NAME, SURNAME, TITLE, ABBREVIATION,
      // CAPITALIZED
      if (
        next.type === TOKEN_TYPE.NAME ||
        next.type === TOKEN_TYPE.SURNAME ||
        next.type === TOKEN_TYPE.TITLE ||
        next.type === TOKEN_TYPE.ABBREVIATION ||
        next.type === TOKEN_TYPE.CAPITALIZED
      ) {
        chain.push(next);
        j++;
      } else {
        break;
      }
    }

    // Score the chain
    const hasTitle = chain.some((t) => t.type === TOKEN_TYPE.TITLE);
    const hasCorpusName = chain.some((t) => isCorpusMatch(t.type));
    const hasFirstName = chain.some((t) => t.type === TOKEN_TYPE.NAME);
    const hasAbbreviation = chain.some(
      (t) => t.type === TOKEN_TYPE.ABBREVIATION,
    );
    const corpusCount = chain.filter((t) => isCorpusMatch(t.type)).length;
    const capitalizedCount = chain.filter(
      (t) => t.type === TOKEN_TYPE.CAPITALIZED,
    ).length;

    // Determine score based on chain composition
    let score = 0;

    if (hasTitle && hasCorpusName) {
      // TITLE + NAME/SURNAME → high confidence
      score = 0.95;
    } else if (corpusCount >= 2) {
      // NAME + NAME, NAME + SURNAME, etc. → high confidence
      score = 0.9;
    } else if (hasCorpusName && capitalizedCount > 0) {
      // NAME/SURNAME + CAPITALIZED → medium confidence
      score = 0.7;
    } else if (hasAbbreviation && hasCorpusName) {
      // ABBREVIATION + NAME/SURNAME → medium confidence
      score = 0.7;
    } else if (hasFirstName && chain.length === 1) {
      // Standalone first NAME → low confidence
      // Skip if at sentence start (likely not a name)
      if (isSentenceStart(fullText, token.start)) {
        continue;
      }
      score = 0.5;
    } else if (
      !hasFirstName &&
      chain.length === 1 &&
      chain[0]?.type === TOKEN_TYPE.SURNAME
    ) {
      // Standalone SURNAME → skip (too ambiguous alone)
      continue;
    } else if (hasTitle && chain.length === 1) {
      // Standalone TITLE → skip (not a name by itself)
      continue;
    } else {
      // No corpus match in chain → skip
      if (!hasCorpusName) {
        continue;
      }
      score = 0.5;
    }

    // Build entity span from first to last token in chain
    const first = chain.at(0);
    const last = chain.at(-1);
    if (!first || !last) {
      continue;
    }

    const start = first.start;
    const end = last.end;
    const text = fullText.slice(start, end);

    // Mark all chain tokens as consumed
    for (let k = i; k < i + chain.length; k++) {
      consumed.add(k);
    }

    entities.push({
      start,
      end,
      label: "person",
      text,
      score,
      source: DETECTION_SOURCES.REGEX,
    });
  }

  return entities;
};
