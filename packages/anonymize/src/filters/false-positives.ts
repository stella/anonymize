import type { Entity } from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";
import { normalizeHomoglyphs } from "../util/homoglyphs";

const TEMPLATE_PLACEHOLDER_RE = /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;

// Patterns that indicate a genuine address (not prose).
const POSTAL_CODE_RE = /\d{3}\s?\d{2}/;
const HAS_DIGIT_RE = /\d/;
// Address-component anchors not derived from per-language
// street-type vocabulary: Czech house/parcel number forms
// (č.p., č.ev., č.) and "sídliště" (housing estate) which
// is a settlement type rather than a street type. Polish,
// English, etc. street vocabulary is loaded from
// address-street-types.json via initAddressComponents.
const ADDRESS_COMPONENT_EXTRA_RE =
  /(?:^|\s)(?:č\.p\.|č\.ev\.|č\.|sídliště)(?=[\s,./]|$)/i;

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

const normalizeEntity = (entity: Entity): Entity | null => {
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

  return {
    ...entity,
    start,
    end: start + text.length,
    text,
  };
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

    const normalized = normalizeEntity(entity);
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

    // Person names never contain digits.
    // "Solution Pack ABL90 Flex" → reject.
    if (normalized.label === "person" && HAS_DIGIT_RE.test(trimmed)) {
      continue;
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
      SIGNING_CLAUSE_ADDRESS_RE.test(trimmed)
    ) {
      continue;
    }

    filtered.push(normalized);
  }

  return filtered;
};
