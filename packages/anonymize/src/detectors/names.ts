import { DETECTION_SOURCES } from "../types";
import type { Dictionaries, Entity } from "../types";
import type { PipelineContext, NameCorpusData } from "../context";
import { defaultContext } from "../context";
import { ALL_UPPER_RE, UPPER_START_RE, isSentenceStart } from "../util/text";

// ── Name corpus ──────────────────────────────────────
// Per-language first names and surnames loaded from
// injected dictionaries (optional) plus legacy
// config/names-*.json for backwards compat. Merged at
// init time across all configured languages.

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
 * Load name corpus data from injected dictionaries
 * and legacy config files. Merges all sources.
 *
 * Safe to call multiple times; only loads once per
 * context. Must be called before detectNameCorpus or
 * the getNameCorpus*() accessors are used.
 *
 * @param dictionaries Optional pre-loaded dictionaries
 *   with per-language first names and surnames. When
 *   omitted, only legacy config files are used.
 */
export const initNameCorpus = (
  ctx: PipelineContext = defaultContext,
  dictionaries?: Dictionaries,
  languages?: readonly string[],
): Promise<void> => {
  const languageKey = languages?.toSorted().join(",") ?? "*";
  if (ctx.nameCorpus && ctx.nameCorpusKey === languageKey) {
    return Promise.resolve();
  }
  if (ctx.nameCorpusPromise && ctx.nameCorpusKey === languageKey) {
    return ctx.nameCorpusPromise;
  }
  ctx.nameCorpus = null;
  ctx.nameCorpusKey = languageKey;
  const promise = (async () => {
    try {
      // Load legacy config files (backwards compat)
      const [
        legacyFirstMod,
        legacySurnameMod,
        titleMod,
        exclusionMod,
        commonWordsMod,
      ] = await Promise.all([
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
        import("../data/common-words-en.json") as Promise<{
          default: { words: string[] };
        }>,
      ]);

      // Merge: legacy config + injected per-language files
      const firstNames: string[] = [...legacyFirstMod.default.names];
      if (dictionaries?.firstNames) {
        const entries =
          languages === undefined
            ? Object.entries(dictionaries.firstNames)
            : Object.entries(dictionaries.firstNames).filter(([language]) =>
                languages.includes(language),
              );
        for (const [, names] of entries) {
          for (const name of names) {
            firstNames.push(name);
          }
        }
      }

      const surnames: string[] = [...legacySurnameMod.default.names];
      if (dictionaries?.surnames) {
        const entries =
          languages === undefined
            ? Object.entries(dictionaries.surnames)
            : Object.entries(dictionaries.surnames).filter(([language]) =>
                languages.includes(language),
              );
        for (const [, names] of entries) {
          for (const name of names) {
            surnames.push(name);
          }
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

      const commonWords = new Set(
        commonWordsMod.default.words.map((word) => word.toLowerCase()),
      );
      const dedupFirst = dedup(firstNames);
      const dedupSurnames = dedup(surnames).filter(
        (name) => !commonWords.has(name.toLowerCase()),
      );
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

// ── Czech/Slovak declension paradigm ─────────────────
// Full case paradigm (genitive, dative, accusative,
// vocative, locative, instrumental) for Czech and
// Slovak first names and surnames. One rule table
// drives both directions:
//  - expandNameDeclensions() generates declined
//    variants injected as deny-list AC patterns;
//  - stripInflection() maps a declined token back to
//    nominative candidates for corpus lookup.
// Rules are gated purely by the orthographic shape of
// the nominative ending; never by individual names.

type DeclensionRule = {
  /** Nominative ending replaced by each form ("" appends). */
  ending: string;
  /** Shape gate tested against the lowercased nominative. */
  gate: RegExp;
  /** Case endings substituted for `ending`. */
  forms: readonly string[];
};

const DECLENSION_RULES: readonly DeclensionRule[] = [
  // Masculine, hard/neutral consonant final (Jan, Novák):
  // gen/acc -a, dat/loc/voc -u, dat/loc -ovi, instr -em
  // (cs) / -om (sk). ł counts as a hard consonant so
  // bundled Polish names (Paweł) decline in cs/sk text.
  {
    ending: "",
    gate: /[bdfghklmnpqrstvwxzł]$/u,
    forms: ["a", "u", "ovi", "em", "om"],
  },
  // Masculine vocative -e after non-velar hard consonants
  // (Jane, Adame). Velars take -u (Nováku) and r
  // palatalises (Petře), so they are not licensed here.
  { ending: "", gate: /[bdflmnpstvwz]$/u, forms: ["e"] },
  // Masculine, soft consonant final (Tomáš, Ondřej, Kráľ):
  // cs gen/acc -e, dat/loc/voc -i, sk gen/acc -a,
  // dat/loc -ovi, instr -em (cs) / -om (sk).
  {
    ending: "",
    gate: /[cčďťňřšžjľ]$/u,
    forms: ["e", "i", "a", "ovi", "em", "om"],
  },
  // Fleeting -e-: Czech drops the e before case endings
  // (Marek → Marka, Pavel → Pavla/Pavle, Němec → Němce).
  // The consonant rules above keep the Slovak forms that
  // retain the e (Mareka, Marekovi).
  {
    ending: "ek",
    gate: /[^aeiouyáéěíóôúůý]ek$/u,
    forms: ["ka", "ku", "kovi", "kem", "kom"],
  },
  {
    ending: "el",
    gate: /[^aeiouyáéěíóôúůý]el$/u,
    forms: ["la", "lu", "le", "lovi", "lem", "lom"],
  },
  {
    ending: "ec",
    gate: /[^aeiouyáéěíóôúůý]ec$/u,
    forms: ["ce", "ci", "covi", "cem", "com"],
  },
  // -a final, hard stem (Jana, Svoboda): gen -y, acc -u,
  // voc -o, instr -ou, masculine dat/loc -ovi.
  {
    ending: "a",
    gate: /[^cčďťňřšžji]a$/u,
    forms: ["y", "u", "o", "ou", "ovi"],
  },
  // -a final, soft stem (Saša): gen -i instead of -y.
  {
    ending: "a",
    gate: /[cčďťňřšžj]a$/u,
    forms: ["i", "u", "o", "ou", "ovi"],
  },
  // -ia final (Mária, Lívia): sk gen -ie, dat/loc -ii,
  // acc -iu, instr -iou.
  { ending: "a", gate: /ia$/u, forms: ["e", "i", "u", "ou"] },
  // Feminine dative/locative with regular stem
  // alternation (Jitka → Jitce, Barbora → Barboře cs /
  // Barbore sk, Olga → Olze, Jana → Janě cs / Jane sk,
  // Tereza → Tereze).
  { ending: "ka", gate: /ka$/u, forms: ["ce"] },
  { ending: "ra", gate: /ra$/u, forms: ["ře", "re"] },
  { ending: "ha", gate: /ha$/u, forms: ["ze"] },
  { ending: "ga", gate: /ga$/u, forms: ["ze"] },
  { ending: "cha", gate: /cha$/u, forms: ["še"] },
  { ending: "a", gate: /[bdfmnptv]a$/u, forms: ["ě", "e"] },
  { ending: "a", gate: /[szl]a$/u, forms: ["e"] },
  // -á final, adjectival feminine (Nováková, Veselá):
  // cs gen/dat/loc -é, acc/instr -ou; sk gen/dat/loc
  // -ej, acc -ú.
  { ending: "á", gate: /á$/u, forms: ["é", "ou", "ej", "ú"] },
  // -ý final, adjectival masculine (Černý, Veselý):
  // gen/acc -ého, dat -ému, loc -ém, instr -ým.
  { ending: "ý", gate: /ý$/u, forms: ["ého", "ému", "ém", "ým"] },
  // -í/-i/-y final (Jiří, Krejčí, Henry): pronominal
  // declension +ho (gen/acc), +mu (dat), +m (loc/instr).
  { ending: "", gate: /[íiy]$/u, forms: ["ho", "mu", "m"] },
  // -e/-ie final feminine (Alice, Marie, Lucie):
  // dat/acc/loc -i, instr -í.
  { ending: "e", gate: /[^aeouyáéěíóôúůý]e$/u, forms: ["i", "í"] },
  // -o final masculine (Ivo, Janko, Hugo): gen/acc -a,
  // dat/loc -ovi, instr -em (cs) / -om (sk).
  { ending: "o", gate: /o$/u, forms: ["a", "ovi", "em", "om"] },
];

/**
 * Generate declined Czech/Slovak variants of a
 * nominative name. Only variants licensed by the
 * ending-shape rules are produced, which bounds the
 * deny-list AC pattern growth. Returns an empty array
 * for names too short to decline safely.
 */
export const expandNameDeclensions = (name: string): string[] => {
  if (name.length < 3) {
    return [];
  }
  const lower = name.toLowerCase();
  const variants: string[] = [];
  for (const rule of DECLENSION_RULES) {
    if (!rule.gate.test(lower)) {
      continue;
    }
    const stem = name.slice(0, name.length - rule.ending.length);
    if (stem.length < 2) {
      continue;
    }
    for (const form of rule.forms) {
      variants.push(stem + form);
    }
  }
  return variants;
};

/**
 * Strip Czech/Slovak case endings from a token using
 * the inverse of DECLENSION_RULES. Returns candidate
 * nominative forms; each candidate is validated against
 * the rule's shape gate, so only bases the paradigm
 * could actually have declined are proposed. Callers
 * check candidates against the name corpus.
 */
const stripInflection = (token: string): string[] => {
  const candidates: string[] = [];
  for (const rule of DECLENSION_RULES) {
    for (const form of rule.forms) {
      if (token.length <= form.length + 2 || !token.endsWith(form)) {
        continue;
      }
      const base = token.slice(0, token.length - form.length) + rule.ending;
      if (!/^\p{Lu}/u.test(base)) {
        continue;
      }
      if (!rule.gate.test(base.toLowerCase())) {
        continue;
      }
      candidates.push(base);
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

// True when the line containing `start` is itself
// predominantly upper-case (signature block, title
// block, party caption). Used so the acronym filter
// below can still match all-caps tokens that match
// the name corpus in title-case ("ELON R. MUSK") while
// still rejecting acronyms in mixed-case prose.
const ALL_CAPS_NAME_LINE_RATIO = 0.9;
const ALL_CAPS_NAME_LINE_MIN_LETTERS = 3;
// Name-shape filter for the all-caps recovery path:
// real party-caption and signature lines contain only
// a handful of letter tokens and no digits ("ELON R.
// MUSK", "X HOLDINGS I, INC."). Disclosure/heading
// lines that happen to include a corpus first name
// ("SERVICE MARK LICENSE", "ANNUAL STATEMENT OF
// COMPLIANCE") fail this check and stay OTHER.
const ALL_CAPS_NAME_LINE_MAX_TOKENS = 6;
const isAllCapsLineNameShaped = (fullText: string, start: number): boolean => {
  const lineStart = fullText.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = fullText.indexOf("\n", start);
  const line = fullText.slice(
    lineStart,
    lineEndIdx === -1 ? fullText.length : lineEndIdx,
  );
  if (/\d/.test(line)) return false;
  const tokens = line.match(/\p{L}[\p{L}\p{M}'-]*/gu) ?? [];
  return tokens.length > 0 && tokens.length <= ALL_CAPS_NAME_LINE_MAX_TOKENS;
};

const isAllCapsContextLine = (fullText: string, start: number): boolean => {
  const lineStart = fullText.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = fullText.indexOf("\n", start);
  const line = fullText.slice(
    lineStart,
    lineEndIdx === -1 ? fullText.length : lineEndIdx,
  );
  let letters = 0;
  let upper = 0;
  for (const ch of line) {
    if (/\p{L}/u.test(ch)) {
      letters += 1;
      if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
        upper += 1;
      }
    }
  }
  if (letters < ALL_CAPS_NAME_LINE_MIN_LETTERS) {
    return false;
  }
  return upper / letters >= ALL_CAPS_NAME_LINE_RATIO;
};

const classifyToken = (
  word: WordSegment,
  corpus: NameCorpusData,
  fullText: string,
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

  // `Intl.Segmenter` splits middle initials into a
  // letter word and a separate punctuation segment
  // ("R." → word "R" + "."), so the standard
  // `isAbbreviation` check (which requires a length-2
  // "X." token) misses them. Recognise a single
  // uppercase letter immediately followed by a "." in
  // the source text as an abbreviation too, so chains
  // like "ADAM R. BARTOŠ" don't break on the initial.
  //
  // Standalone enumerators ("A. Definitions",
  // "Section R. Adam") look identical to middle
  // initials at the token level. Distinguish by the
  // previous word on the same line: a middle initial
  // is always preceded by a name-corpus first name,
  // so only classify as ABBREVIATION when that
  // structural context is present.
  if (text.length === 1 && UPPER_START_RE.test(text) && fullText[end] === ".") {
    const lineStart = fullText.lastIndexOf("\n", start - 1) + 1;
    const before = fullText.slice(lineStart, start).trimEnd();
    const lastWord = /\p{L}[\p{L}\p{M}'-]*$/u.exec(before)?.[0];
    if (lastWord) {
      const lookup = (token: string): boolean =>
        isFirstNameToken(token, corpus) ||
        isFirstNameToken(
          (token[0] ?? "") + token.slice(1).toLowerCase(),
          corpus,
        );
      if (lookup(lastWord)) {
        return { text, type: TOKEN_TYPE.ABBREVIATION, start, end };
      }
    }
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Skip excluded words
  if (corpus.excludedWords.has(lower)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Minimum length 3
  if (text.length < 3) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // All-uppercase tokens >= 3 chars are usually
  // acronyms, but in a signature or title block they are
  // real names rendered in caps ("ELON R. MUSK", "JAN
  // NOVÁK"). Allow the corpus lookup in title-case only
  // when (a) the line itself is overwhelmingly upper-
  // case and (b) the line looks name-shaped — few
  // tokens, no digits — so all-caps disclosure prose
  // such as "SERVICE MARK LICENSE" doesn't surface
  // "MARK" as a person via the corpus.
  if (text.length >= 3 && ALL_UPPER_RE.test(text)) {
    if (
      isAllCapsContextLine(fullText, start) &&
      isAllCapsLineNameShaped(fullText, start)
    ) {
      const titleCased = (text[0] ?? "") + text.slice(1).toLowerCase();
      if (isFirstNameToken(titleCased, corpus)) {
        return { text, type: TOKEN_TYPE.NAME, start, end };
      }
      if (isSurnameToken(titleCased, corpus)) {
        return { text, type: TOKEN_TYPE.SURNAME, start, end };
      }
    }
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
  const tokens = words.map((w) => classifyToken(w, corpus, fullText));
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
    let score: number;

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
      // Standalone all-caps corpus hits are too
      // ambiguous on their own to emit. "MARK" inside
      // "SERVICE MARK LICENSE" matches the corpus but
      // is plainly a common noun in context; we need
      // chain evidence (another name token, a title,
      // an abbreviation) before we trust an all-caps
      // first-name token as a person.
      const first = chain[0];
      if (first && ALL_UPPER_RE.test(first.text) && first.text.length >= 3) {
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
