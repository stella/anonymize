import { DETECTION_SOURCES } from "../types";
import type { Dictionaries, Entity } from "../types";
import type { KeyedLoad, PipelineContext, NameCorpusData } from "../context";
import { defaultContext } from "../context";
import {
  HONORIFIC_ABBREVIATION,
  NONWESTERN_HONORIFICS,
  TITLE_PREFIXES,
} from "../config/titles";
import { ALL_UPPER_RE, UPPER_START_RE, isSentenceStart } from "../util/text";
import { dictionaryIdentityKey } from "../util/dictionary-identity";

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
export const getNameCorpusNonWesternNames = (
  ctx: PipelineContext = defaultContext,
): readonly string[] => ctx.nameCorpus?.nonWesternNamesList ?? [];

const NONWESTERN_LOCALE_KEYS = [
  "in",
  "ar",
  "ja-latn",
  "ko",
  "zh-latn",
  "th",
  "vi",
  "fil",
  "id",
] as const;

type NonWesternNamesModule = Promise<{ default: { names: string[] } }>;

// Literal import specifiers so the bundler resolves each corpus
// file into the build output; a template-literal specifier survives
// bundling as a runtime-relative path that does not exist in dist.
const NONWESTERN_NAME_IMPORTS: Record<
  (typeof NONWESTERN_LOCALE_KEYS)[number],
  () => NonWesternNamesModule
> = {
  in: () => import("../data/names-nw-in.json"),
  ar: () => import("../data/names-nw-ar.json"),
  "ja-latn": () => import("../data/names-nw-ja-latn.json"),
  ko: () => import("../data/names-nw-ko.json"),
  "zh-latn": () => import("../data/names-nw-zh-latn.json"),
  th: () => import("../data/names-nw-th.json"),
  vi: () => import("../data/names-nw-vi.json"),
  fil: () => import("../data/names-nw-fil.json"),
  id: () => import("../data/names-nw-id.json"),
};

const normalizeCorpusLanguage = (language: string): string =>
  language.toLowerCase();

const getScopedNonWesternLocaleKeys = (
  languages: readonly string[] | undefined,
): readonly (typeof NONWESTERN_LOCALE_KEYS)[number][] => {
  if (languages === undefined) {
    return NONWESTERN_LOCALE_KEYS;
  }
  const allowed = new Set(languages.map(normalizeCorpusLanguage));
  return NONWESTERN_LOCALE_KEYS.filter((locale) => allowed.has(locale));
};

const getScopedNonWesternHonorifics = (
  languages: readonly string[] | undefined,
): string[] => {
  const entries = Object.entries(NONWESTERN_HONORIFICS);
  if (languages === undefined) {
    return entries.flatMap(([, forms]) => forms);
  }
  const allowed = new Set(languages.map(normalizeCorpusLanguage));
  return entries
    .filter(([locale]) => allowed.has(normalizeCorpusLanguage(locale)))
    .flatMap(([, forms]) => forms);
};

/**
 * Stable identity key for a name corpus load.
 *
 * Keys by both the selected languages AND the injected dictionaries identity:
 * the loaded corpus merges legacy JSON with per-language dictionary entries, so
 * two configs sharing one context but differing only by their dictionaries
 * (e.g. an earlier config with none, a later one with a full bundle) must not
 * reuse each other's corpus. See __test__/context-cache-keying.test.ts.
 */
export const nameCorpusCacheKey = (
  dictionaries: Dictionaries | undefined,
  languages: readonly string[] | undefined,
): string =>
  `${dictionaryIdentityKey(dictionaries)}|${
    languages?.toSorted().join(",") ?? "*"
  }`;

/**
 * Load name corpus data from injected dictionaries
 * and legacy config files. Merges all sources.
 *
 * Safe to call multiple times; only loads once per
 * context+key. Must be called (and awaited) before
 * detectNameCorpus or the getNameCorpus*() accessors are used.
 *
 * Resolves to the loaded corpus (or null on failure). The value travels on the
 * returned promise so a caller reads ITS config's corpus even when a different
 * config concurrently replaces the shared `ctx.nameCorpus` slot. The atomic
 * keyed record (`ctx.nameCorpusLoad`) dedups same-key callers and lets an
 * outdated load skip the shared write.
 *
 * @param dictionaries Optional pre-loaded dictionaries
 *   with per-language first names and surnames. When
 *   omitted, only legacy config files are used.
 */
export const initNameCorpus = (
  ctx: PipelineContext = defaultContext,
  dictionaries?: Dictionaries,
  languages?: readonly string[],
): Promise<NameCorpusData | null> => {
  const key = nameCorpusCacheKey(dictionaries, languages);
  const inflight = ctx.nameCorpusLoad;
  if (inflight && inflight.key === key) {
    return inflight.promise;
  }
  const promise = (async (): Promise<NameCorpusData | null> => {
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

      // Merge non-Western honorifics into title tokens.
      // Strip trailing dots/dashes and lowercase so they
      // match the lowercased form used in classifyToken.
      const titles = [...titleMod.default.tokens];
      const scopedNonWesternHonorifics =
        getScopedNonWesternHonorifics(languages);
      for (const form of scopedNonWesternHonorifics) {
        titles.push(form.replace(/[.-]+$/u, "").toLowerCase());
      }
      const dedupTitles = dedup(titles);

      // Build abbreviation-style title set: titles whose
      // trailing dot is part of the abbreviation, not a
      // sentence boundary. Used by chain assembly to avoid
      // breaking chains on "Dr. Smith", "Smt. Irani", etc.
      const titleAbbrSet = new Set<string>();
      // Western titles with trailing dots (Ing., Dr., etc.)
      for (const prefix of TITLE_PREFIXES) {
        if (prefix.endsWith(".")) {
          titleAbbrSet.add(prefix.replace(/[.-]+$/u, "").toLowerCase());
        }
      }
      // Explicit abbreviation honorifics (Mr, Ms, etc.)
      for (const form of HONORIFIC_ABBREVIATION) {
        titleAbbrSet.add(form.replace(/[.-]+$/u, "").toLowerCase());
      }
      // Non-Western honorifics with dotted forms (Smt., Pt., Adv., etc.)
      for (const form of scopedNonWesternHonorifics) {
        if (form.endsWith(".")) {
          titleAbbrSet.add(form.replace(/[.-]+$/u, "").toLowerCase());
        }
      }

      const exclusions = exclusionMod.default.words;

      // ── Load non-Western name tokens ────────────────
      // Per-locale JSON files + optional injected data.
      const nwLocaleKeys = getScopedNonWesternLocaleKeys(languages);
      const [nwNameMods, nwExcludedMod] = await Promise.all([
        Promise.all(
          nwLocaleKeys.map((locale) => NONWESTERN_NAME_IMPORTS[locale]()),
        ),
        import("../data/names-nw-excluded-allcaps.json") as Promise<{
          default: { words: string[] };
        }>,
      ]);

      const nonWesternNames: string[] = [];
      for (const mod of nwNameMods) {
        for (const name of mod.default.names) {
          nonWesternNames.push(name);
        }
      }
      if (dictionaries?.nonWesternNames) {
        const entries =
          languages === undefined
            ? Object.entries(dictionaries.nonWesternNames)
            : (() => {
                const allowed = new Set(languages.map(normalizeCorpusLanguage));
                return Object.entries(dictionaries.nonWesternNames).filter(
                  ([language]) =>
                    allowed.has(normalizeCorpusLanguage(language)),
                );
              })();
        for (const [, names] of entries) {
          for (const name of names) {
            nonWesternNames.push(name);
          }
        }
      }
      const dedupNonWestern = dedup(nonWesternNames);
      const dedupExcludedAllCaps = dedup(nwExcludedMod.default.words);

      const corpus: NameCorpusData = {
        firstNames: Object.freeze(new Set(dedupFirst)),
        surnames: Object.freeze(new Set(dedupSurnames)),
        titleTokens: Object.freeze(new Set(dedupTitles)),
        titleAbbreviations: Object.freeze(titleAbbrSet),
        excludedWords: Object.freeze(new Set(exclusions)),
        commonWords: Object.freeze(commonWords),
        nonWesternNames: Object.freeze(new Set(dedupNonWestern)),
        excludedAllCaps: Object.freeze(new Set(dedupExcludedAllCaps)),
        firstNamesList: Object.freeze(dedupFirst),
        surnamesList: Object.freeze(dedupSurnames),
        titlesList: Object.freeze(dedupTitles),
        excludedList: Object.freeze(exclusions),
        nonWesternNamesList: Object.freeze(dedupNonWestern),
        excludedAllCapsList: Object.freeze(dedupExcludedAllCaps),
      };
      return corpus;
    } catch (err) {
      console.warn(
        "[anonymize] Failed to load name corpus JSON" +
          " — name detection disabled:",
        err,
      );
      return null;
    }
  })();
  // Set the record on the context SYNCHRONOUSLY, before returning, so a
  // concurrent different-key caller sees and replaces it. The resolved corpus
  // travels on `promise`, so every caller reads its own config's value; the
  // shared `ctx.nameCorpus` slot is only a convenience for legacy sync
  // accessors and is written by the current record when it resolves.
  const record: KeyedLoad<NameCorpusData | null> = { key, promise };
  ctx.nameCorpusLoad = record;
  void promise.then((corpus) => {
    if (ctx.nameCorpusLoad !== record) {
      // A newer config replaced us; leave its state alone.
      return;
    }
    if (corpus) {
      ctx.nameCorpus = corpus;
    } else {
      // Failed load: clear the record so the next call retries, and clear the
      // sync slot so legacy accessors don't keep serving a previous config's
      // corpus under this record's key.
      ctx.nameCorpusLoad = null;
      ctx.nameCorpus = null;
    }
  });
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
  JA_SUFFIX: "ja_suffix",
  ARABIC_CONNECTOR: "arabic_connector",
  CAPITALIZED: "capitalized",
  OTHER: "other",
} as const;

type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE];

type ClassifiedToken = {
  text: string;
  type: TokenType;
  start: number;
  end: number;
  /** True when matched via nonWesternNames corpus. */
  nonWestern?: boolean;
  /** True when this is an abbreviation-style title (Dr, Mr, Smt, etc.)
   *  whose trailing dot is not a sentence boundary. */
  titleAbbreviation?: boolean;
};

const PERSON_CHAIN_BREAK_RE = /[!?;:]/u;

type NameCorpusDetectionOptions = {
  mode?: "full" | "supplemental";
};

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

/**
 * Title-case a token, re-capitalizing after apostrophes
 * so D'Souza, O'Brien, Hon'ble match the corpus.
 */
const titleCaseWithApostrophe = (text: string): string =>
  (text[0]?.toUpperCase() ?? "") +
  text
    .slice(1)
    .toLowerCase()
    .replace(/'\p{Ll}/gu, (m) => m.toUpperCase());

/**
 * Check if a token is in the non-Western name corpus.
 * Tries both title-cased (with apostrophe re-cap) and
 * raw forms.
 */
const isNonWesternNameToken = (
  token: string,
  corpus: NameCorpusData,
): boolean => {
  if (corpus.nonWesternNames.has(token)) return true;
  return corpus.nonWesternNames.has(titleCaseWithApostrophe(token));
};

// ── Non-Western pattern helpers ─────────────────────

/** Japanese honorific suffixes attached via hyphen. */
const JA_SUFFIXES = new Set(["san", "sama", "sensei"]);

/** Arabic patronymic connectors. */
const ARABIC_CONNECTORS = new Set(["bin", "bint", "ibn", "al", "el"]);

/** Al-/El- prefixed name pattern (e.g., Al-Rashid, El-Amin). */
const AL_EL_PREFIX_RE = /^[Aa]l-[A-Z][a-z]+$|^[Ee]l-[A-Z][a-z]+$/u;

/** CJK name detection: 2-4 Han chars not adjacent to others. */
const CJK_NAME_RE =
  /(?<!\p{Script=Han})\p{Script=Han}{2,4}(?!\p{Script=Han})/gu;

/** Han character threshold for CJK-majority documents. */
const CJK_HAN_RATIO = 0.15;

const CJK_NON_PERSON_TERMS = new Set([
  "中国",
  "中國",
  "中文",
  "人民",
  "公司",
  "香港",
  "台湾",
  "臺灣",
  "日本",
  "韩国",
  "韓國",
]);

const CJK_SURNAME_CHARS = new Set(
  [
    "王",
    "李",
    "张",
    "張",
    "刘",
    "劉",
    "陈",
    "陳",
    "杨",
    "楊",
    "黄",
    "黃",
    "赵",
    "趙",
    "吴",
    "吳",
    "周",
    "徐",
    "孙",
    "孫",
    "马",
    "馬",
    "朱",
    "胡",
    "郭",
    "何",
    "林",
    "高",
    "梁",
    "郑",
    "鄭",
    "罗",
    "羅",
    "宋",
    "谢",
    "謝",
    "唐",
    "韩",
    "韓",
    "曹",
    "许",
    "許",
    "邓",
    "鄧",
    "萧",
    "蕭",
    "田",
    "山",
    "佐",
    "鈴",
    "渡",
    "伊",
    "中",
    "小",
    "吉",
    "金",
    "朴",
    "박",
    "김",
    "이",
    "최",
    "정",
    "강",
    "조",
    "윤",
    "장",
    "임",
    "한",
  ].join(""),
);

const isLikelyCjkPersonName = (text: string): boolean => {
  if (CJK_NON_PERSON_TERMS.has(text)) {
    return false;
  }
  const first = text.at(0);
  return first !== undefined && CJK_SURNAME_CHARS.has(first);
};

/** Organization keyword filter. */
const ORG_WORDS =
  /\b(?:Group|Company|LLC|LLP|LP|Inc|Ltd|Corp|Corporation|Holdings|Partners|Association|University|Bank|Fund|Trust|Agency|Government|Ministry|Office|Department|Council|Board|Committee|Commission|Services|Solutions|Technologies|Systems|Analytics|Software)\b/i;

const isOrganization = (text: string): boolean => ORG_WORDS.test(text);

/** Deduplicate overlapping entity spans (first wins). */
const deduplicateSpans = (entities: Entity[]): Entity[] => {
  const sorted = [...entities].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const result: Entity[] = [];
  for (const entity of sorted) {
    const last = result.at(-1);
    if (!last || entity.start >= last.end) {
      result.push(entity);
    }
  }
  return result;
};

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

  // 1. Title tokens (Western + non-Western honorifics)
  if (corpus.titleTokens.has(stripped)) {
    // Mark abbreviation-style titles so the chain
    // assembler knows their trailing dot is not a
    // sentence boundary (Dr., Mr., Smt. etc.).
    return {
      text,
      type: TOKEN_TYPE.TITLE,
      start,
      end,
      ...(corpus.titleAbbreviations.has(stripped)
        ? { titleAbbreviation: true }
        : {}),
    };
  }

  // 2. Japanese honorific suffixes (san, sama, sensei)
  if (JA_SUFFIXES.has(lower)) {
    return { text, type: TOKEN_TYPE.JA_SUFFIX, start, end };
  }

  // 3. Arabic patronymic connectors (bin, bint, ibn, al, el)
  if (ARABIC_CONNECTORS.has(lower)) {
    return { text, type: TOKEN_TYPE.ARABIC_CONNECTOR, start, end };
  }

  // 4. Al-/El- prefixed name pattern (Al-Rashid, El-Amin)
  if (AL_EL_PREFIX_RE.test(text)) {
    return { text, type: TOKEN_TYPE.NAME, start, end, nonWestern: true };
  }

  // 5. Abbreviation (initials like "R.", "M.")
  if (isAbbreviation(text)) {
    return {
      text,
      type: TOKEN_TYPE.ABBREVIATION,
      start,
      end,
    };
  }

  // 5b. Multi-dot abbreviation patterns (A.P.J, K.C.R)
  if (/^(?:\p{Lu}\.)+\p{Lu}?$/u.test(text)) {
    return { text, type: TOKEN_TYPE.ABBREVIATION, start, end };
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
  // initials at the token level. Distinguish by
  // structural context: a middle initial is preceded by
  // a name-corpus first name, OR followed by another
  // name token (covering "R. K. Narayan" where "R"
  // starts the name but is followed by "K.").
  if (text.length === 1 && UPPER_START_RE.test(text) && fullText[end] === ".") {
    const lineStart = fullText.lastIndexOf("\n", start - 1) + 1;
    const before = fullText.slice(lineStart, start).trimEnd();
    const lastWord = /\p{L}[\p{L}\p{M}'-]*$/u.exec(before)?.[0];
    const lookup = (token: string): boolean =>
      isFirstNameToken(token, corpus) ||
      isFirstNameToken(
        (token[0] ?? "") + token.slice(1).toLowerCase(),
        corpus,
      ) ||
      isNonWesternNameToken(token, corpus);
    // Check preceding context (middle initial after a name)
    if (lastWord && lookup(lastWord)) {
      return { text, type: TOKEN_TYPE.ABBREVIATION, start, end };
    }
    // Check following context (initial before a name or
    // another initial, e.g., "R. K. Narayan")
    const afterDot = fullText.slice(end + 1).trimStart();
    const nextWord = /^\p{L}[\p{L}\p{M}'-]*/u.exec(afterDot)?.[0];
    if (nextWord) {
      const isNextName =
        lookup(nextWord) ||
        (nextWord.length === 1 && UPPER_START_RE.test(nextWord));
      if (isNextName) {
        return { text, type: TOKEN_TYPE.ABBREVIATION, start, end };
      }
    }
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Skip excluded words
  if (corpus.excludedWords.has(lower)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Minimum length 3 for Western corpus matching, but
  // allow 2-char tokens that match the non-Western name
  // corpus (e.g., "Yi", "Li", "Vo"), are Arabic
  // connectors / Japanese suffixes already classified,
  // or are short all-caps post-nominals not in the
  // excluded-all-caps set (e.g., "JP", "KC", "QC").
  if (text.length < 2) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }
  if (
    text.length < 3 &&
    !isNonWesternNameToken(text, corpus) &&
    !JA_SUFFIXES.has(lower) &&
    !ARABIC_CONNECTORS.has(lower) &&
    !(ALL_UPPER_RE.test(text) && !corpus.excludedAllCaps.has(text))
  ) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // All-uppercase tokens >= 3 chars are usually
  // acronyms, but there are two legitimate name contexts:
  //
  // 1. Signature/title blocks: "ELON R. MUSK", "JAN
  //    NOVÁK" — allowed when the line is overwhelmingly
  //    upper-case and looks name-shaped.
  // 2. Non-Western family-name-first convention: "SATO
  //    Kenji", "PARK Jihoon" — the surname is written in
  //    ALL CAPS with the given name in title case. This is
  //    valid even in mixed-case text, so we check the
  //    non-Western corpus without requiring an all-caps
  //    line context.
  if (text.length >= 3 && ALL_UPPER_RE.test(text)) {
    // Exclude common all-caps acronyms
    if (corpus.excludedAllCaps.has(text)) {
      return { text, type: TOKEN_TYPE.OTHER, start, end };
    }
    const titleCased = (text[0] ?? "") + text.slice(1).toLowerCase();
    const nwMatch = isNonWesternNameToken(titleCased, corpus);

    // Non-Western all-caps surname pattern (SATO, PARK,
    // KIM, etc.) — valid without all-caps line context
    if (nwMatch && !isFirstNameToken(titleCased, corpus)) {
      return { text, type: TOKEN_TYPE.NAME, start, end, nonWestern: true };
    }

    // Signature/title block all-caps recovery path
    if (
      isAllCapsContextLine(fullText, start) &&
      isAllCapsLineNameShaped(fullText, start)
    ) {
      if (isFirstNameToken(titleCased, corpus)) {
        return {
          text,
          type: TOKEN_TYPE.NAME,
          start,
          end,
          ...(nwMatch ? { nonWestern: true } : {}),
        };
      }
      if (isSurnameToken(titleCased, corpus)) {
        return {
          text,
          type: TOKEN_TYPE.SURNAME,
          start,
          end,
          ...(nwMatch ? { nonWestern: true } : {}),
        };
      }
      // Non-Western corpus match only (not in Western
      // corpus) in all-caps name-shaped line
      if (nwMatch) {
        return { text, type: TOKEN_TYPE.NAME, start, end, nonWestern: true };
      }
    }
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  // Must start with uppercase
  if (!UPPER_START_RE.test(text)) {
    return { text, type: TOKEN_TYPE.OTHER, start, end };
  }

  if (isFirstNameToken(text, corpus)) {
    // Also flag as non-Western if matched by both corpora
    const nw = isNonWesternNameToken(text, corpus);
    return {
      text,
      type: TOKEN_TYPE.NAME,
      start,
      end,
      ...(nw ? { nonWestern: true } : {}),
    };
  }

  if (isSurnameToken(text, corpus)) {
    const nw = isNonWesternNameToken(text, corpus);
    return {
      text,
      type: TOKEN_TYPE.SURNAME,
      start,
      end,
      ...(nw ? { nonWestern: true } : {}),
    };
  }

  // Non-Western name corpus check (after Western
  // corpus, so a token in both gets type NAME/SURNAME
  // with nonWestern flag rather than type NAME alone).
  if (isNonWesternNameToken(text, corpus)) {
    return { text, type: TOKEN_TYPE.NAME, start, end, nonWestern: true };
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
 * Handles both Western and non-Western name patterns.
 *
 * Requires initNameCorpus() to have been called first.
 * If not initialized, returns an empty array.
 *
 * Scoring (Western):
 *   TITLE + NAME/SURNAME       → 0.95
 *   NAME + NAME/SURNAME        → 0.9
 *   SURNAME + NAME/SURNAME     → 0.9
 *   NAME + CAPITALIZED         → 0.7
 *   ABBREVIATION + NAME        → 0.7
 *   Standalone NAME            → 0.5 (low confidence)
 *   Standalone SURNAME         → skip (too ambiguous)
 *
 * Scoring (non-Western, when chain contains nonWestern tokens):
 *   TITLE + (nonWestern|CAPITALIZED) → 0.95
 *   JA_SUFFIX + (CAPITALIZED|nonWestern) → 0.9
 *   ARABIC_CONNECTOR + nonWestern     → 0.9
 *   2+ nonWestern tokens              → 0.9
 *   nonWestern + (CAPITALIZED|ABBREVIATION) → 0.9
 *   Standalone nonWestern mid-sentence → 0.5
 */
export const detectNameCorpus = (
  fullText: string,
  ctx: PipelineContext = defaultContext,
  options: NameCorpusDetectionOptions = {},
): Entity[] => {
  const corpus = getCorpus(ctx);
  if (!corpus) {
    return [];
  }

  const supplementalMode = options.mode === "supplemental";
  const entities: Entity[] = [];

  // ── CJK pre-pass ─────────────────────────────────
  // Only detect CJK names in Latin-majority documents
  // (CJK-majority text has too many Han characters for
  // this heuristic to be useful).
  const threshold = Math.ceil(fullText.length * CJK_HAN_RATIO);
  let hanCount = 0;
  for (const _ of fullText.matchAll(/\p{Script=Han}/gu)) {
    hanCount++;
    if (hanCount >= threshold) break;
  }
  const isLatinMajority = fullText.length < 100 || hanCount < threshold;
  if (isLatinMajority) {
    CJK_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CJK_NAME_RE.exec(fullText)) !== null) {
      const cjkText = match[0];
      if (isLikelyCjkPersonName(cjkText) && !isOrganization(cjkText)) {
        entities.push({
          start: match.index,
          end: match.index + cjkText.length,
          label: "person",
          text: cjkText,
          score: 0.95,
          source: DETECTION_SOURCES.REGEX,
        });
      }
    }
  }

  // ── Token-based detection ────────────────────────
  const words = segmentWords(fullText);

  // Convert word segments to classified tokens,
  // handling s/o, d/o, w/o, r/o relational connectors
  // as single ARABIC_CONNECTOR tokens.
  const tokens: ClassifiedToken[] = [];
  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx]!;
    const lower = word.text.toLowerCase();
    const nextWord = words[idx + 1];
    if (
      (lower === "s" || lower === "d" || lower === "w" || lower === "r") &&
      fullText[word.end] === "/" &&
      nextWord &&
      nextWord.start === word.end + 1 &&
      nextWord.text.toLowerCase() === "o"
    ) {
      tokens.push({
        text: fullText.slice(word.start, word.end + 2),
        type: TOKEN_TYPE.ARABIC_CONNECTOR,
        start: word.start,
        end: word.end + 2,
      });
      idx++;
    } else {
      tokens.push(classifyToken(word, corpus, fullText));
    }
  }

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
    // ABBREVIATION, or ARABIC_CONNECTOR (JA_SUFFIX
    // alone is not a valid chain start)
    if (
      token.type !== TOKEN_TYPE.TITLE &&
      token.type !== TOKEN_TYPE.NAME &&
      token.type !== TOKEN_TYPE.SURNAME &&
      token.type !== TOKEN_TYPE.ABBREVIATION &&
      token.type !== TOKEN_TYPE.ARABIC_CONNECTOR
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
        // A period in the gap breaks the chain, unless:
        // 1. The gap looks like an initial continuation
        //    (e.g., "R." between two initials).
        // 2. The previous token is an abbreviation-style
        //    title (Dr., Mr., Smt.) whose trailing dot is
        //    part of the abbreviation, not a sentence end.
        // 3. The previous token is an abbreviation (R., K.,
        //    A.P.J.) whose trailing dot is part of the
        //    abbreviation.
        const periodIsPartOfPrevToken =
          prev.type === TOKEN_TYPE.ABBREVIATION ||
          (prev.type === TOKEN_TYPE.TITLE && prev.titleAbbreviation === true);
        const breaksOnPeriod =
          gap.includes(".") &&
          !isInitialContinuationGap(prev.text, gap) &&
          !periodIsPartOfPrevToken;
        if (
          gap.includes("\n") ||
          PERSON_CHAIN_BREAK_RE.test(gap) ||
          breaksOnPeriod
        ) {
          break;
        }
        // Japanese suffixes only attach via hyphen or
        // whitespace (no other gap allowed)
        if (
          next.type === TOKEN_TYPE.JA_SUFFIX &&
          gap !== "-" &&
          gap.trim() !== ""
        ) {
          break;
        }
      }

      // Chain NAME, SURNAME, TITLE, ABBREVIATION,
      // CAPITALIZED, JA_SUFFIX, ARABIC_CONNECTOR
      if (next.type !== TOKEN_TYPE.OTHER) {
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
    const hasNonWestern = chain.some((t) => t.nonWestern === true);
    const hasJaSuffix = chain.some((t) => t.type === TOKEN_TYPE.JA_SUFFIX);
    const hasArabicConnector = chain.some(
      (t) => t.type === TOKEN_TYPE.ARABIC_CONNECTOR,
    );
    const corpusCount = chain.filter((t) => isCorpusMatch(t.type)).length;
    const capitalizedCount = chain.filter(
      (t) => t.type === TOKEN_TYPE.CAPITALIZED,
    ).length;
    const nonWesternCount = chain.filter((t) => t.nonWestern).length;
    // A chain whose every token is a common English word is a
    // common-word phrase, not a person — even when one token
    // happens to coincide with a non-Western given name (e.g.
    // "Loan Documents"/"Loan Amount", where "Loan" is also a
    // Vietnamese name). Only used to veto the weakest
    // single-non-Western-token heuristic below; chains with a
    // second corpus name, title, or connector are unaffected.
    const chainAllCommonWords = chain.every((t) =>
      corpus.commonWords.has(t.text.toLowerCase()),
    );

    // Determine score based on chain composition
    let score: number;

    if (hasNonWestern) {
      // ── Non-Western scoring path ─────────────────
      if (hasTitle && (nonWesternCount > 0 || capitalizedCount > 0)) {
        score = 0.95;
      } else if (hasJaSuffix && (capitalizedCount > 0 || nonWesternCount > 0)) {
        score = 0.9;
      } else if (hasArabicConnector && nonWesternCount > 0) {
        score = 0.9;
      } else if (nonWesternCount >= 2) {
        score = 0.9;
      } else if (
        nonWesternCount > 0 &&
        (capitalizedCount > 0 || hasAbbreviation) &&
        !chainAllCommonWords
      ) {
        score = 0.9;
      } else if (
        nonWesternCount === 1 &&
        chain.length === 1 &&
        !isSentenceStart(fullText, token.start)
      ) {
        // Standalone non-Western token mid-sentence
        score = 0.5;
      } else {
        // Insufficient evidence for non-Western chain
        continue;
      }
      if (supplementalMode && score < 0.9) {
        continue;
      }
    } else if (supplementalMode) {
      continue;
    } else {
      // ── Western scoring path (unchanged) ─────────
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
      } else if (hasJaSuffix || hasArabicConnector) {
        // JA_SUFFIX or ARABIC_CONNECTOR without a name
        // token is not a person by itself
        if (!hasCorpusName && !hasFirstName) {
          continue;
        }
        score = 0.5;
      } else {
        // No corpus match in chain → skip
        if (!hasCorpusName) {
          continue;
        }
        score = 0.5;
      }
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

    // Reject organization-like spans
    if (isOrganization(text)) {
      continue;
    }

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

  return deduplicateSpans(entities);
};
