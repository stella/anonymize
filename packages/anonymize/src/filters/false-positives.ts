import type { Entity } from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";
import { getPersonStopwords } from "../detectors/deny-list";
import { normalizeHomoglyphs } from "../util/homoglyphs";

const TEMPLATE_PLACEHOLDER_RE = /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;

// Patterns that indicate a genuine address (not prose).
const POSTAL_CODE_RE = /\d{3}\s?\d{2}/;
const HAS_DIGIT_RE = /\d/;
// Address-component anchors not derived from per-language
// street-type vocabulary: Czech house/parcel number forms
// (č.p., č.ev., č.) and "sídliště" (housing estate) which
// is a settlement type rather than a street type. Polish,
// pt-BR, English, etc. street vocabulary is loaded from
// address-street-types.json via initAddressComponents.
const ADDRESS_COMPONENT_EXTRA_RE =
  /(?:^|\s)(?:č\.p\.|č\.ev\.|č\.|sídliště)(?=[\s,./]|$)/i;

// Bare French "cours" is ambiguous: "Cours Mirabeau" is a
// genuine street, but "au cours du contrat" is prose. Real
// addresses either include digits (caught by the prior
// rule) or a capitalized proper-name token right after
// `cours`. Returns true when the only address-component
// token in `text` is bare lowercase `cours` AND it is not
// followed by a capitalized name token, i.e. the entity is
// almost certainly prose and should be rejected.
const BARE_COURS_PROSE_RE = /(?:^|\s)cours(?!\s+\p{Lu})(?=[\s,./]|$)/u;
const isOnlyAmbiguousCours = (text: string): boolean => {
  if (!BARE_COURS_PROSE_RE.test(text)) return false;
  // Strip every bare "cours" occurrence; if anything else
  // still matches a street-type word, the entity has
  // other street-type evidence and is not "only cours".
  const stripped = text.replace(/(?:^|\s)cours(?=[\s,./]|$)/gi, " ");
  return !hasAddressComponent(stripped);
};

// Jurisdiction patterns: "State of X", "Commonwealth of X",
// "District of X", "Territory of X"
// — valid address entities without digits or street words.
const JURISDICTION_RE = /^(?:state|commonwealth|district|territory)\s+of\s+/i;

// Max entity text length by label. Prevents runaway
// trigger extractions (e.g., "město Dobříš i okolních
// obcí...") from producing absurdly long entities.
const MAX_ENTITY_LENGTH: Partial<Record<string, number>> = {
  organization: 80,
  person: 60,
};

// Per-label upper bound on word count. Real-world
// organisation names cap out well below this even for
// long firm names ("European Bank for Reconstruction
// and Development" — 6). A trigger or coreference span
// running past this is almost certainly absorbing prose.
// Only open-ended sources (trigger, coreference) are
// subject to this cap: gazetteer/NER/regex detections
// are bounded by their dictionary, model, or pattern
// and may legitimately span longer names like "The
// University of Texas Health Science Center at Houston".
const MAX_ENTITY_WORDS: Partial<Record<string, number>> = {
  organization: 8,
};
const OPEN_ENDED_SOURCES: ReadonlySet<string> = new Set([
  "trigger",
  "coreference",
]);
const WORD_TOKEN_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-./]*/gu;
const countWordTokens = (text: string): number => {
  let count = 0;
  WORD_TOKEN_RE.lastIndex = 0;
  while (WORD_TOKEN_RE.exec(text) !== null) count += 1;
  return count;
};

// Lines whose visible letters are overwhelmingly
// uppercase are EITHER:
//   - heading/boilerplate prose (SEC securities legends,
//     "THIS INSTRUMENT AND ANY SECURITIES ..." clauses,
//     numbered section headings such as "17.NO
//     ASSIGNMENT."),
//   - or genuine party captions where a real org name
//     happens to be rendered in caps on its own line
//     ("TWITTER, INC.", "X HOLDINGS I, INC.").
// The old guard rejected both cases. We now keep
// captions: the deciding signal is whether the line
// contains substantial *prose* outside the candidate
// span. SEC legends sprawl across the line; captions
// occupy nearly all of it. A numbered section heading
// ("17.NO ASSIGNMENT.") is also rejected outright
// because its all-caps span is part of the section
// title, not a party name.
const ALL_CAPS_LINE_LETTER_THRESHOLD = 5;
const ALL_CAPS_LINE_RATIO = 0.95;
const ALL_CAPS_LINE_PROSE_EXTRA_LETTERS = 20;
// A genuine party caption has the shape "Name[, ]Suffix"
// — short, with a comma marking the suffix break (or no
// suffix-style separator at all). Heading lines such as
// "REGISTRATION STATEMENT" or Czech "RÁMCOVÁ DOHODA NA
// POSKYTOVÁNÍ PRÁVNÍCH SLUŽEB" are longer prose-style
// sequences without a comma. The word-count cutoff is
// deliberately permissive; legitimate firm names like
// "European Bank for Reconstruction and Development"
// (6 words) keep their comma + legal-form suffix, so
// they retain the suffix break test above.
const ALL_CAPS_LINE_HEADING_WORD_LIMIT = 5;
// Section-number prefix at the start of a line, with
// optional leading whitespace so indented headings
// ("    17. NO ASSIGNMENT.", "§ 3") still match. The
// trailing uppercase character anchors the title token.
const SECTION_HEADING_PREFIX_RE =
  /^\s*(?:§\s*)?\d{1,3}(?:\.\d{1,3}){0,4}\.?\s*\p{Lu}/u;
const LINE_LETTER_RE = /\p{L}/gu;
const ENTITY_WORD_TOKEN_RE = /\p{L}[\p{L}\p{M}\p{N}'’-]*/gu;
const isAllCapsBoilerplateLine = (
  fullText: string,
  start: number,
  length: number,
): boolean => {
  const lineStart = fullText.lastIndexOf("\n", start) + 1;
  const lineEndIdx = fullText.indexOf("\n", start + length);
  const line = fullText.slice(
    lineStart,
    lineEndIdx === -1 ? fullText.length : lineEndIdx,
  );
  let letterCount = 0;
  let upperCount = 0;
  let outsideEntityLetters = 0;
  const entityRelStart = start - lineStart;
  const entityRelEnd = entityRelStart + length;
  LINE_LETTER_RE.lastIndex = 0;
  for (
    let m = LINE_LETTER_RE.exec(line);
    m !== null;
    m = LINE_LETTER_RE.exec(line)
  ) {
    const ch = m[0];
    letterCount += 1;
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
      upperCount += 1;
    }
    if (m.index < entityRelStart || m.index >= entityRelEnd) {
      outsideEntityLetters += 1;
    }
  }
  if (letterCount <= ALL_CAPS_LINE_LETTER_THRESHOLD) return false;
  if (upperCount / letterCount < ALL_CAPS_LINE_RATIO) return false;
  // Numbered section headings are always boilerplate.
  if (SECTION_HEADING_PREFIX_RE.test(line)) return true;
  // SEC legend / paragraph: substantial all-caps prose
  // outside the entity span.
  if (outsideEntityLetters >= ALL_CAPS_LINE_PROSE_EXTRA_LETTERS) return true;
  // Heading-shape inside the entity itself: many words
  // and no comma to mark a Name+Suffix break. Czech
  // section titles ("RÁMCOVÁ DOHODA NA POSKYTOVÁNÍ
  // PRÁVNÍCH SLUŽEB") match here. Real captions like
  // "ACME CORPORATION" (2 words, no comma) and
  // "TWITTER, INC." (comma) survive.
  const entityText = fullText.slice(start, start + length);
  const entityWordCount = (entityText.match(ENTITY_WORD_TOKEN_RE) ?? []).length;
  if (
    entityWordCount > ALL_CAPS_LINE_HEADING_WORD_LIMIT &&
    !entityText.includes(",")
  ) {
    return true;
  }
  return false;
};
const isAllCapsCandidate = (text: string): boolean =>
  text === text.toUpperCase() && /\p{Lu}/u.test(text);
// Section/clause numbers: "§ 3", "3.2.1", "12." but NOT
// dates like "4.3.2026" or long digit strings like IČO.
// A section number has 1-3 digit groups of 1-3 digits each,
// never ending with a 4-digit group (that's a year).
const SECTION_NUMBER_RE = /^(?:§\s*)?\d{1,3}(?:\.\d{1,3}){0,4}\.?$/;
const STANDALONE_YEAR_RE = /^(?:19|20)\d{2}$/;

// Number-abbreviation prefixes: "č.", "Nr.", "No.", "nr.",
// "no.", "n.", "čís." — when a numeric entity is preceded
// by one of these, it's a reference number, not PII.
const NUMBER_ABBREV_RE = /(?:^|[\s(])(?:č|čís|nr|no|n)\.\s*$/i;
const SIGNING_CLAUSE_ADDRESS_RE = /^(?:v|ve)\s+[^\d,\n]{1,40},?\s+dne$/iu;
const PERSON_TRAILING_NOUNS: ReadonlySet<string> = new Set([
  "association",
  "period",
  "reform",
]);
const LEGAL_FORM_HEADING_RE = /\b(?:agreement|amendment|contract|exhibit)\b/iu;
const LEADING_ARTIFACT_RE = /^(?:\.\s)+/u;
const ADDRESS_ROLE_PREFIX_RE =
  /^(?:prodávajícího|kupujícího|objednatele|zhotovitele|pronajímatele|dodavatele|odběratele|zaměstnance|zaměstnavatele|nájemce)\s+(?=(?:\p{Lu}|\d|ul\.?|ulice|nám\.?|náměstí|tř\.?|třída|nábř\.?|nábřeží|č\.p\.?|č\.ev\.?|sídliště))/iu;
const ADDRESS_INLINE_ABBREV_AFTER_RE =
  /^(?:\p{Lu}[\p{L}\p{M}]{0,3}\.|ul\.?|nám\.?|tř\.?|nábř\.?|č\.p\.?|č\.ev\.?)/u;
const ADDRESS_INLINE_ABBREV_BEFORE_RE =
  /(?:^|[\s,])(?:st|ave|rd|dr|blvd|ln|hwy|pkwy|cir|ct|pl|sq|ter|trl|ste|apt|bldg|fl|ul|nám|tř|nábř|č\.p|č\.ev)$/iu;
const ADDRESS_CONTINUATION_WORD_RE =
  /^(?:suite|building|floor|unit|apartment|room|tower|wing|block|bldg|ste|apt|fl)\b/iu;

const trimTrailingAddressProse = (text: string): string => {
  for (const match of text.matchAll(/\.(?=\s+\p{Lu})/gu)) {
    const cutoff = match.index;
    if (cutoff === undefined) {
      continue;
    }
    const before = text.slice(0, cutoff);
    if (!HAS_DIGIT_RE.test(before)) {
      continue;
    }
    const after = text.slice(cutoff + 1).trimStart();
    if (
      after.length < 5 ||
      ADDRESS_INLINE_ABBREV_AFTER_RE.test(after) ||
      ADDRESS_INLINE_ABBREV_BEFORE_RE.test(before.trimEnd()) ||
      ADDRESS_CONTINUATION_WORD_RE.test(after)
    ) {
      continue;
    }
    return before.trimEnd();
  }

  return text;
};

const collapseEntityWhitespace = (text: string): string =>
  text.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");

const normalizeEntityFromRaw = (
  entity: Entity,
  fullText: string,
): Entity | null => {
  let start = entity.start;
  let end = entity.end;
  let text = fullText.slice(start, end);

  const trimLeading = (re: RegExp) => {
    const match = re.exec(text);
    if (!match) {
      return;
    }
    start += match[0].length;
    text = text.slice(match[0].length);
  };

  trimLeading(LEADING_ARTIFACT_RE);
  trimLeading(/^\s+/u);

  if (entity.label === "address") {
    trimLeading(ADDRESS_ROLE_PREFIX_RE);
    const beforeTrim = text;
    text = trimTrailingAddressProse(text);
    end -= beforeTrim.length - text.length;
  }

  const trailingMatch = /[,\s]+$/u.exec(text);
  if (trailingMatch) {
    end -= trailingMatch[0].length;
    text = text.slice(0, text.length - trailingMatch[0].length);
  }

  if (text.length === 0) {
    return null;
  }

  return {
    ...entity,
    start,
    end,
    text: collapseEntityWhitespace(text),
  };
};

const normalizeEntity = (entity: Entity, fullText?: string): Entity | null => {
  if (fullText !== undefined) {
    return normalizeEntityFromRaw(entity, fullText);
  }

  let start = entity.start;
  let text = entity.text;

  const trimLeading = (re: RegExp) => {
    const match = re.exec(text);
    if (!match) {
      return;
    }
    start += match[0].length;
    text = text.slice(match[0].length);
  };

  trimLeading(LEADING_ARTIFACT_RE);
  trimLeading(/^\s+/u);

  if (entity.label === "address") {
    trimLeading(ADDRESS_ROLE_PREFIX_RE);
    text = trimTrailingAddressProse(text);
  }

  const trailingMatch = /[,\s]+$/u.exec(text);
  if (trailingMatch) {
    text = text.slice(0, text.length - trailingMatch[0].length);
  }

  if (text.length === 0) {
    return null;
  }

  const removedFromFront = start - entity.start;
  const removedFromBack = entity.text.length - removedFromFront - text.length;
  const end = entity.end - removedFromBack;

  return {
    ...entity,
    start,
    end,
    text,
  };
};

// ── Document-structure headings (lazy-loaded from JSON) ──
//
// Per-language list of heading words (`příloha`, `anlage`,
// `schedule`, …) that the trigger detector emits as organisations
// when they precede an ordinal-abbreviation+digit shape
// (`č. 2`, `Nr. 3`, `No. 4`). The set is loaded once and cached on
// the module — the heading vocabulary is language-data, not state.

let cachedHeadingRe: RegExp | null = null;
let cachedHeadingPromise: Promise<RegExp> | null = null;
const ORDINAL_MARKER = "(?:č|no|nr|n)\\.?";

const buildHeadingRegex = (words: readonly string[]): RegExp => {
  if (words.length === 0) {
    return /[\s\S](?!)/u;
  }
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const escaped = sorted
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(
    `^(?:${escaped})[\\s\\u00a0]+(?:${ORDINAL_MARKER}|#)[\\s\\u00a0]*\\d`,
    "iu",
  );
};

const loadHeadingWords = async (): Promise<readonly string[]> => {
  try {
    const mod = await import("../data/document-structure-headings.json");
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON shape
    const data = (mod as { default?: Record<string, unknown> }).default ?? mod;
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON shape
    const entries = Object.entries(data as Record<string, unknown>);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [key, value] of entries) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(value)) continue;
      for (const word of value) {
        if (typeof word !== "string" || word.length === 0) continue;
        const lc = word.toLowerCase();
        if (seen.has(lc)) continue;
        seen.add(lc);
        out.push(lc);
      }
    }
    return out;
  } catch {
    return [];
  }
};

export const loadDocumentStructureHeadings = async (): Promise<void> => {
  if (cachedHeadingRe) return;
  cachedHeadingPromise ??= loadHeadingWords().then(buildHeadingRegex);
  cachedHeadingRe = await cachedHeadingPromise;
};

const isDocumentStructureHeading = (text: string): boolean => {
  const re = cachedHeadingRe;
  if (!re) return false;
  return re.test(text);
};

// ── Generic roles (lazy-loaded from JSON) ────────────

const EMPTY_GENERIC_ROLES: ReadonlySet<string> = new Set();

/**
 * Load generic-roles.json and cache the result on the
 * given context. Must be awaited during pipeline init
 * so the sync accessor is populated before
 * filterFalsePositives runs.
 */
export const loadGenericRoles = (
  ctx: PipelineContext = defaultContext,
): Promise<ReadonlySet<string>> => {
  if (ctx.genericRolesPromise) {
    return ctx.genericRolesPromise;
  }
  ctx.genericRolesPromise = (async () => {
    try {
      const mod: {
        default?: { roles?: string[] };
      } = await import("../data/generic-roles.json");
      const set: ReadonlySet<string> = new Set(mod.default?.roles ?? []);
      ctx.genericRoles = set;
      return set;
    } catch {
      const empty: ReadonlySet<string> = new Set();
      ctx.genericRoles = empty;
      return empty;
    }
  })();
  return ctx.genericRolesPromise;
};

/** Sync accessor — returns empty set before init. */
const getGenericRoles = (ctx: PipelineContext): ReadonlySet<string> =>
  ctx.genericRoles ?? EMPTY_GENERIC_ROLES;

// ── Street-type vocabulary (lazy-loaded from JSON) ───
//
// Builds a single regex from address-street-types.json
// that recognises any per-language street word (Polish
// "aleja", "ulicy"; English "Street", "Avenue"; etc.) as
// a genuine address component. Falls back to a permissive
// match-nothing regex before init.

// Baseline regex used when address-street-types.json
// has not been loaded yet (e.g. callers using
// `filterFalsePositives` directly without going through
// `runPipeline`). Mirrors the previous hardcoded Czech
// street-word anchors so trigger-sourced digitless
// Czech addresses ("Národní třída") still survive the
// digit gate before initAddressComponents() runs.
const STREET_TYPES_SEED_RE =
  /(?:^|\s)(?:ul\.|ulice|nám\.|náměstí|tř\.|třída|nábř\.|nábřeží|bulvár)(?=[\s,./]|$)/i;
let _streetTypesRe: RegExp = STREET_TYPES_SEED_RE;
let _streetTypesPromise: Promise<void> | null = null;

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const loadStreetTypeRegex = async (): Promise<void> => {
  try {
    const mod: { default?: Record<string, string[] | string> } =
      await import("../data/address-street-types.json");
    const data = mod.default ?? {};
    const words = new Set<string>();
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      if (!Array.isArray(val)) continue;
      for (const w of val) {
        if (typeof w === "string" && w.length > 0) {
          words.add(w.toLowerCase());
        }
      }
    }
    if (words.size === 0) {
      _streetTypesRe = STREET_TYPES_SEED_RE;
      return;
    }
    // Longest first so "aleja" doesn't shadow "al."
    const alternation = [...words]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");
    _streetTypesRe = new RegExp(
      `(?:^|\\s)(?:${alternation})(?=[\\s,./]|$)`,
      "iu",
    );
  } catch {
    _streetTypesRe = STREET_TYPES_SEED_RE;
  }
};

/** Ensure street-type vocabulary is loaded. */
export const initAddressComponents = (): Promise<void> => {
  if (!_streetTypesPromise) {
    _streetTypesPromise = loadStreetTypeRegex();
  }
  return _streetTypesPromise;
};

/**
 * True when `text` contains a recognised address
 * component: either a per-language street word (loaded
 * from JSON) or a language-agnostic anchor such as a
 * Czech house number form.
 */
const hasAddressComponent = (text: string): boolean =>
  _streetTypesRe.test(text) || ADDRESS_COMPONENT_EXTRA_RE.test(text);

const isCallerOwnedEntity = (entity: Entity): boolean =>
  entity.sourceDetail === "custom-deny-list" ||
  entity.sourceDetail === "custom-regex";

/**
 * Filter out entities that are likely false positives:
 * template placeholders, clause/section numbers,
 * standalone years, and generic legal role terms.
 *
 * Runs as a post-processing step after all detection
 * layers have merged.
 */
export const filterFalsePositives = (
  entities: Entity[],
  ctx: PipelineContext = defaultContext,
  fullText?: string,
): Entity[] => {
  const filtered: Entity[] = [];
  const roles = getGenericRoles(ctx);

  for (const entity of entities) {
    if (isCallerOwnedEntity(entity)) {
      filtered.push(entity);
      continue;
    }

    const normalized = normalizeEntity(entity, fullText);
    if (!normalized) {
      continue;
    }

    // Strip leading ". " artifacts from trigger extraction
    // after abbreviations ("dat. nar.", "č.p.").
    const trimmed = normalized.text;

    if (isCallerOwnedEntity(normalized)) {
      filtered.push(normalized);
      continue;
    }

    if (TEMPLATE_PLACEHOLDER_RE.test(trimmed)) {
      continue;
    }
    // Reject entities exceeding max length for their
    // label (prevents runaway trigger extractions).
    // Exempt legal-form entities: their span is already
    // bounded by the regex pattern, not open-ended.
    const maxLen = MAX_ENTITY_LENGTH[normalized.label];
    if (
      maxLen &&
      trimmed.length > maxLen &&
      normalized.source !== "legal-form"
    ) {
      continue;
    }
    // Word-count cap. The byte-length cap above only
    // catches truly runaway spans; a 70-char trigger
    // capture full of short jargon words still slips
    // through despite being clearly prose. Org names in
    // practice cap out at 6 words even for verbose firm
    // names; 8 leaves headroom without admitting a full
    // boilerplate clause.
    const maxWords = MAX_ENTITY_WORDS[normalized.label];
    if (
      maxWords &&
      OPEN_ENDED_SOURCES.has(normalized.source) &&
      countWordTokens(trimmed) > maxWords
    ) {
      continue;
    }
    // SEC-style legends, numbered section headings
    // ("17.NO ASSIGNMENT."), and other boilerplate
    // disclosure blocks render as all-uppercase lines.
    // Detectors anchored to uppercase tokens otherwise
    // emit bigrams like "SECURITIES ACT" or
    // "REGISTRATION STATEMENT" as organization spans,
    // and the legal-form regex matches headings such as
    // "NO ASSIGNMENT". Real party captions almost always
    // carry a legal-form suffix ("ACME CORPORATION")
    // and survive via the legal-forms detector's own
    // 3-word-on-mixed-case pathway, so we gate every
    // all-caps organization candidate whose surrounding
    // line is itself all-caps regardless of source.
    if (
      fullText &&
      normalized.label === "organization" &&
      isAllCapsCandidate(trimmed) &&
      isAllCapsBoilerplateLine(fullText, normalized.start, trimmed.length)
    ) {
      continue;
    }
    // Section numbers (§ 3, 3.2.1, 12.) are false
    // positives unless they were captured by a trigger
    // phrase (e.g., "č.p. 92" is an address, not a
    // section number).
    if (SECTION_NUMBER_RE.test(trimmed) && normalized.source !== "trigger") {
      continue;
    }
    // Standalone years (2022, 1995) without a trigger
    // context are noise. Trigger-sourced years are
    // valid ("rok 2022", "year 2019").
    if (STANDALONE_YEAR_RE.test(trimmed) && normalized.source !== "trigger") {
      continue;
    }

    // Numeric entities preceded by a number abbreviation
    // ("č.", "Nr.", "No.") are usually reference
    // numbers, not PII. Apply this only to non-trigger
    // entities: trigger-based detections intentionally
    // use these abbreviations as their semantic anchor
    // (e.g. "parc. č. 852/2", "LV č. 154",
    // "Flurstück Nr. 1234").
    if (
      fullText &&
      normalized.source !== "trigger" &&
      /^\d/.test(trimmed) &&
      NUMBER_ABBREV_RE.test(
        fullText.slice(Math.max(0, normalized.start - 10), normalized.start),
      )
    ) {
      continue;
    }

    if (
      normalized.label === "registration number" &&
      /^[\p{L}]{1,2}$/u.test(trimmed)
    ) {
      continue;
    }

    // Document-structure headings (Czech `Příloha č.2`, German
    // `Anlage Nr. 3`, English `Schedule No. 4`) get captured by the
    // trigger detector as organizations. They are scaffolding, not
    // party references. The heading vocabulary lives in
    // `data/document-structure-headings.json`; the regex composes the
    // current word set with the cross-language ordinal abbreviations.
    if (
      normalized.label === "organization" &&
      isDocumentStructureHeading(trimmed)
    ) {
      continue;
    }

    // Person names never contain digits.
    // "Solution Pack ABL90 Flex" → reject.
    if (normalized.label === "person" && HAS_DIGIT_RE.test(trimmed)) {
      continue;
    }

    // Demonstrative pronouns and other words that collide
    // with rare given names in the corpus (e.g. Czech
    // "Tato" — both a sentence-opening demonstrative and
    // an Italian/Iberian first name). The deny-list path
    // applies this filter itself; this catches the same
    // tokens when they leak out of NER or any other
    // single-token person source.
    if (normalized.label === "person") {
      const trimmedToken = trimmed.replace(/[.,;:!?]+$/u, "").trim();
      if (
        !/\s/.test(trimmedToken) &&
        getPersonStopwords(ctx).has(trimmedToken.toLowerCase())
      ) {
        continue;
      }
    }

    if (normalized.label === "person") {
      const tokens = trimmed.split(/\s+/u);
      // Fold homoglyphs *before* lowercasing: uppercase
      // Greek lookalikes (Α, Ε, …) lowercase to Greek
      // lowercase code points that aren't in the
      // homoglyph map, so the order matters.
      const last = tokens.at(-1)?.replace(/[.,;:!?]+$/u, "");
      const lastFolded = last
        ? normalizeHomoglyphs(last).toLowerCase()
        : undefined;
      if (
        tokens.length > 1 &&
        lastFolded &&
        PERSON_TRAILING_NOUNS.has(lastFolded)
      ) {
        continue;
      }
    }

    if (
      (normalized.label === "person" || normalized.label === "organization") &&
      roles.has(normalizeHomoglyphs(trimmed).toLowerCase())
    ) {
      continue;
    }

    if (
      normalized.label === "organization" &&
      normalized.source === "legal-form" &&
      trimmed === trimmed.toUpperCase() &&
      LEGAL_FORM_HEADING_RE.test(trimmed)
    ) {
      continue;
    }

    // Reject long address entities that look like prose:
    // no digits, no postal code, no known address
    // component (street abbreviations, etc.).
    if (
      normalized.label === "address" &&
      trimmed.length > 40 &&
      !POSTAL_CODE_RE.test(trimmed) &&
      !HAS_DIGIT_RE.test(trimmed) &&
      !hasAddressComponent(trimmed) &&
      !JURISDICTION_RE.test(trimmed)
    ) {
      continue;
    }

    // Reject ANY trigger-sourced address without digits
    // and without a known street-type word. Catches
    // non-address text like "Nejsme plátci DPH !".
    // Exempt jurisdiction patterns ("State of ...",
    // "Commonwealth of ...") which are valid addresses
    // without digits. The street-type fallback covers
    // non-Czech vocabulary loaded from JSON, so e.g.
    // Italian `Via Roma` is preserved.
    //
    // Special case: French "cours" is highly ambiguous
    // ("au cours du contrat" vs. "Cours Mirabeau"). When
    // bare `cours` is the only street-type token and the
    // entity has no digits, require it to look like a
    // proper-name address (capitalized token following).
    if (
      normalized.label === "address" &&
      normalized.source === "trigger" &&
      !HAS_DIGIT_RE.test(trimmed) &&
      !hasAddressComponent(trimmed) &&
      !JURISDICTION_RE.test(trimmed)
    ) {
      continue;
    }
    if (
      normalized.label === "address" &&
      normalized.source === "trigger" &&
      !HAS_DIGIT_RE.test(trimmed) &&
      isOnlyAmbiguousCours(trimmed)
    ) {
      continue;
    }

    if (
      normalized.label === "address" &&
      SIGNING_CLAUSE_ADDRESS_RE.test(trimmed)
    ) {
      continue;
    }

    filtered.push(normalized);
  }

  return filtered;
};
