import { AhoCorasick } from "@stll/aho-corasick";

import { resolveCountries } from "../regions";
import { DETECTION_SOURCES } from "../types";
import type { Entity, PipelineConfig } from "../types";
import { normalizeForSearch } from "../util/normalize";

/**
 * Try to load the optional @stll/anonymize-data package.
 * Returns null if not installed.
 */
const loadDataModule = async (): Promise<
  typeof import("@stll/anonymize-data") | null
> => {
  try {
    return await import("@stll/anonymize-data");
  } catch {
    return null;
  }
};

export type DenyListConfig = Pick<
  PipelineConfig,
  | "enableDenyList"
  | "denyListCountries"
  | "denyListRegions"
  | "denyListExcludeCategories"
>;

const UPPER_START_RE = /^\p{Lu}/u;
const ALL_UPPER_RE = /^\p{Lu}+$/u;

/**
 * Known abbreviations that should not be flagged.
 * These are common institutional acronyms that appear
 * frequently in legal text but are not PII.
 */
const ALLOW_LIST: ReadonlySet<string> = new Set([
  "eu",
  "amu",
  "ldn",
  "mpsv",
  "mfčr",
  "škola",
  "čr",
  "sr",
  "čssr",
  "gdpr",
  "dph",
  "bic",
]);

/**
 * Global stopwords: common words across Czech, German,
 * English, and Slovak that happen to match name/institution
 * entries. Checked case-insensitively against matches.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Titles misidentified as names
  "ing",
  // Czech common words that match names
  "cena",
  "rady",
  "sleva",
  "horky",
  "osoba",
  "dary",
  "manka",
  "doba",
  "doby",
  "dle",
  "pro",
  "pod",
  "tom",
  "nad",
  "bude",
  "jeho",
  "ale",
  "ani",
  "pak",
  "tak",
  "jen",
  "jak",
  "kde",
  "kdy",
  "kdo",
  "ted",
  "jiz",
  "vse",
  "pri",
  "bez",
  "ven",
  "den",
  "rok",
  "rad",
  "dum",
  "vec",
  "cas",
  "pan",
  "pani",
  "rada",
  "veci",
  "strana",
  "strany",
  "cast",
  "konec",
  "smlouva",
  "smlouvy",
  "zakon",
  "zakona",
  "zakonu",
  "clanek",
  "clanku",
  "odstavec",
  "sluzba",
  "sluzby",
  "ucel",
  "ucelu",
  "zpusob",
  "oblast",
  "celkem",
  "pouze",
  "rovnez",
  "zaroven",
  "uvedeny",
  "dalsi",
  "smluvni",
  "predmet",
  "zmena",
  "zmeny",
  "plneni",
  // Czech words matching university abbreviations
  "mu",
  "vse",
  // German common words that match names
  "aber",
  "auch",
  "auf",
  "aus",
  "bei",
  "bis",
  "das",
  "dem",
  "den",
  "der",
  "die",
  "ein",
  "eine",
  "fur",
  "hat",
  "ich",
  "ist",
  "mit",
  "nach",
  "nicht",
  "noch",
  "nur",
  "oder",
  "sie",
  "und",
  "von",
  "war",
  "was",
  "wer",
  "wie",
  "will",
  "sind",
  "wird",
  "zeit",
  "recht",
  "fall",
  "ware",
  "leben",
  "arbeit",
  // English/tech words that match names
  "temp",
  "fede",
  "abner",
  "office",
  "swift",
  "esco",
  "data",
  "money",
  "payment",
  "contractor",
  "seller",
  "sellers",
  "counsellor",
  "count",
  "purchase",
  "share",
  "price",
  "board",
  "group",
  "civil",
  "code",
  "key",
  "company",
  "director",
  "leaver",
  "pool",
  "change",
  "business",
  "day",
  "meeting",
  "person",
  "service",
  "public",
  "stock",
  "simple",
  "safe",
  "cap",
  "standard",
  "common",
  "freedom",
  "rector",
  "court",
  "judge",
  "party",
  "state",
  "union",
  "right",
  "order",
  "claim",
  "case",
  "article",
  "section",
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "had",
  "her",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "our",
  "own",
  "say",
  "too",
  "use",
  "way",
  "who",
  "did",
  "get",
  "has",
  "him",
  "let",
  "one",
  "run",
  "set",
  "try",
  "big",
  "end",
  "far",
  "few",
  "got",
  "law",
  "low",
  "man",
  "put",
  "red",
  "top",
  "yes",
  "age",
  "art",
  "bar",
  "bit",
  "boy",
  "car",
  "cut",
  "deal",
  "fact",
  "free",
  "gift",
  "half",
  "hall",
  "hand",
  "here",
  "high",
  "hope",
  "idea",
  "just",
  "kind",
  "land",
  "last",
  "life",
  "like",
  "line",
  "list",
  "long",
  "look",
  "lord",
  "made",
  "make",
  "mark",
  "much",
  "must",
  "name",
  "need",
  "next",
  "note",
  "only",
  "open",
  "over",
  "part",
  "past",
  "plan",
  "play",
  "real",
  "rest",
  "rich",
  "rise",
  "role",
  "rule",
  "same",
  "save",
  "side",
  "sign",
  "site",
  "size",
  "some",
  "step",
  "such",
  "sure",
  "take",
  "tell",
  "term",
  "test",
  "than",
  "that",
  "then",
  "this",
  "time",
  "turn",
  "upon",
  "used",
  "very",
  "want",
  "well",
  "went",
  "what",
  "when",
  "with",
  "word",
  "work",
  "year",
  // Slovak
  "soud",
  "pravo",
  "narok",
  // Country names (not PII)
  "slovak",
  "czech",
  "polish",
  "austria",
  "germany",
]);

/**
 * Pre-built deny list automaton. Constructed once by
 * `buildDenyList`, reused across `scanDenyList` calls.
 */
export type DenyListAutomaton = {
  ac: AhoCorasick;
  /** Maps pattern index → entity label. */
  labels: string[];
  /** Maps pattern index → original pattern text. */
  patterns: string[];
};

/**
 * Resolve which dictionaries to load based on country
 * and category filters, load them, and build the
 * Aho-Corasick automaton. The returned automaton can
 * be reused across multiple `scanDenyList` calls.
 *
 * Requires `@stll/anonymize-data` to be installed.
 * Returns null if the data package is not available.
 */
export const buildDenyList = async (
  config: DenyListConfig,
): Promise<DenyListAutomaton | null> => {
  const dataModule = await loadDataModule();
  if (!dataModule) {
    return null;
  }

  const allowedCountries = resolveCountries(
    config.denyListRegions,
    config.denyListCountries,
  );

  const excluded = config.denyListExcludeCategories;
  const excludeCategories = excluded
    ? new Set(excluded)
    : new Set<string>();

  const allIds = [...dataModule.ALL_DICTIONARY_IDS];

  const ids = allIds.filter((id) => {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) {
      return false;
    }

    if (excludeCategories.has(meta.category)) {
      return false;
    }

    if (allowedCountries === null) {
      return true;
    }

    if (meta.country === null) {
      return true;
    }

    return allowedCountries.has(meta.country);
  });

  const patternList: string[] = [];
  const labelList: string[] = [];
  const seen = new Set<string>();

  const results = await Promise.all(
    ids.map(async (id) => {
      const entries =
        await dataModule.loadDictionary(id);
      return { id, entries };
    }),
  );

  for (const { id, entries } of results) {
    const meta = dataModule.DICTIONARY_META[id];
    if (!meta) {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      patternList.push(entry);
      labelList.push(meta.label);
    }
  }

  if (patternList.length === 0) {
    return null;
  }

  const ac = new AhoCorasick(patternList, {
    caseInsensitive: true,
    wholeWords: true,
  });

  return {
    ac,
    labels: labelList,
    patterns: patternList,
  };
};

const SENTENCE_END_RE = /[.!?]/;

/**
 * Check if a position is at the start of a sentence.
 */
const isSentenceStart = (
  text: string,
  pos: number,
): boolean => {
  if (pos === 0) {
    return true;
  }
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i] ?? "")) {
    i--;
  }
  if (i < 0) {
    return true;
  }
  return SENTENCE_END_RE.test(text[i] ?? "");
};

type RawMatch = {
  start: number;
  end: number;
  label: string;
  text: string;
  patternIdx: number;
};

/**
 * Scan text using a pre-built deny list automaton.
 *
 * Two-pass approach to reduce false positives:
 * 1. Collect all matches (case-insensitive,
 *    whole-word via Rust automaton)
 * 2. Require uppercase start in source text
 * 3. For person names, require at least one
 *    mid-sentence occurrence to prove proper noun
 * 4. Return all occurrences of validated terms
 */
export const scanDenyList = (
  fullText: string,
  automaton: DenyListAutomaton,
): Entity[] => {
  // Normalize typographic variants (NBSP, smart quotes,
  // en/em dashes) for matching. Offsets remain valid
  // because all replacements are same-length.
  const normalized = normalizeForSearch(fullText);
  const rawMatches = automaton.ac.findIter(normalized);

  // Pass 1: collect valid matches grouped by pattern
  const matchesByPattern = new Map<
    number,
    RawMatch[]
  >();

  for (const match of rawMatches) {
    const sourceChar = fullText[match.start] ?? "";
    if (!UPPER_START_RE.test(sourceChar)) {
      continue;
    }

    // Use original text for display; normalized was
    // only for the AC search.
    const matchText = fullText.slice(
      match.start,
      match.end,
    );
    const keyword = matchText.toLowerCase();
    if (STOPWORDS.has(keyword) || ALLOW_LIST.has(keyword)) {
      continue;
    }

    // Skip ALL-CAPS tokens (likely acronyms, not PII)
    // unless surrounding context is also all-caps
    if (ALL_UPPER_RE.test(matchText)) {
      continue;
    }

    const label = automaton.labels[match.pattern];
    if (!label) {
      continue;
    }

    const entry: RawMatch = {
      start: match.start,
      end: match.end,
      label,
      text: matchText,
      patternIdx: match.pattern,
    };

    const existing = matchesByPattern.get(
      match.pattern,
    );
    if (existing) {
      existing.push(entry);
    } else {
      matchesByPattern.set(match.pattern, [entry]);
    }
  }

  // Pass 2: for person names, require mid-sentence
  const results: Entity[] = [];

  for (const [, matches] of Array.from(
    matchesByPattern,
  )) {
    const first = matches[0];
    if (!first) {
      continue;
    }

    if (first.label === "person") {
      const hasMidSentence = matches.some(
        (m) => !isSentenceStart(fullText, m.start),
      );
      if (!hasMidSentence) {
        continue;
      }
    }

    for (const m of matches) {
      const extended =
        m.label === "person"
          ? extendPersonName(fullText, m.start, m.end)
          : { end: m.end, text: m.text };

      results.push({
        start: m.start,
        end: extended.end,
        label: m.label,
        text: extended.text,
        score: 0.9,
        source: DETECTION_SOURCES.DENY_LIST,
      });
    }
  }

  return results;
};

/**
 * Extend a person name match to include subsequent
 * capitalized words. "Pavel" + " Heřmánek" → "Pavel
 * Heřmánek". Stops at lowercase words, punctuation,
 * or end of text. Also extends backward if preceded
 * by a capitalized word (for "Miroslav Braňka" when
 * only "Braňka" matched).
 */
const extendPersonName = (
  text: string,
  start: number,
  end: number,
): { end: number; text: string } => {
  let newEnd = end;

  // Extend forward: skip whitespace, check if next
  // word starts with uppercase
  let pos = newEnd;
  while (pos < text.length) {
    // Skip single whitespace
    if (pos < text.length && text[pos] === " ") {
      const wordStart = pos + 1;
      if (wordStart >= text.length) {
        break;
      }

      const char = text[wordStart] ?? "";
      if (!UPPER_START_RE.test(char)) {
        break;
      }

      // Find end of this word
      let wordEnd = wordStart;
      while (
        wordEnd < text.length &&
        !/\s/.test(text[wordEnd] ?? "")
      ) {
        wordEnd++;
      }

      // Skip trailing punctuation (commas, etc.)
      const word = text.slice(wordStart, wordEnd);
      const stripped = word.replace(/[,;.]+$/, "");
      if (stripped.length < 2) {
        break;
      }

      // Don't extend into stopwords
      if (STOPWORDS.has(stripped.toLowerCase())) {
        break;
      }

      newEnd = wordStart + stripped.length;
      pos = newEnd;
    } else {
      break;
    }
  }

  return {
    end: newEnd,
    text: text.slice(start, newEnd),
  };
};
