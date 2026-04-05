import type { Entity } from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";

const TEMPLATE_PLACEHOLDER_RE = /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;

// Patterns that indicate a genuine address (not prose).
const POSTAL_CODE_RE = /\d{3}\s?\d{2}/;
const HAS_DIGIT_RE = /\d/;
const ADDRESS_COMPONENTS_RE =
  /(?:^|\s)(?:ul\.|ulice|nám\.|náměstí|tř\.|třída|nábř\.|nábřeží|č\.p\.|č\.ev\.|č\.|sídliště|bulvár)(?=[\s,./]|$)/i;

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
const SIGNING_CLAUSE_ADDRESS_RE =
  /^(?:v|ve)\s+[^\d,\n]{1,40}\s+dne$/iu;
const PERSON_TRAILING_NOUNS: ReadonlySet<string> = new Set([
  "association",
  "period",
  "reform",
]);

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
      } = await import("@stll/anonymize-data/config/generic-roles.json");
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
    // Strip leading ". " artifacts from trigger extraction
    // after abbreviations ("dat. nar.", "č.p.").
    const trimmed = entity.text.replace(/^(?:\.\s)+/, "").trim();

    if (TEMPLATE_PLACEHOLDER_RE.test(trimmed)) {
      continue;
    }
    // Reject entities exceeding max length for their
    // label (prevents runaway trigger extractions).
    // Exempt legal-form entities: their span is already
    // bounded by the regex pattern, not open-ended.
    const maxLen = MAX_ENTITY_LENGTH[entity.label];
    if (maxLen && trimmed.length > maxLen && entity.source !== "legal-form") {
      continue;
    }
    // Section numbers (§ 3, 3.2.1, 12.) are false
    // positives unless they were captured by a trigger
    // phrase (e.g., "č.p. 92" is an address, not a
    // section number).
    if (SECTION_NUMBER_RE.test(trimmed) && entity.source !== "trigger") {
      continue;
    }
    // Standalone years (2022, 1995) without a trigger
    // context are noise. Trigger-sourced years are
    // valid ("rok 2022", "year 2019").
    if (STANDALONE_YEAR_RE.test(trimmed) && entity.source !== "trigger") {
      continue;
    }

    // Numeric entities preceded by a number abbreviation
    // ("č.", "Nr.", "No.") are reference numbers, not PII.
    if (
      fullText &&
      /^\d/.test(trimmed) &&
      NUMBER_ABBREV_RE.test(
        fullText.slice(Math.max(0, entity.start - 10), entity.start),
      )
    ) {
      continue;
    }

    if (
      entity.label === "registration number" &&
      /^[\p{L}]$/u.test(trimmed)
    ) {
      continue;
    }

    // Person names never contain digits.
    // "Solution Pack ABL90 Flex" → reject.
    if (entity.label === "person" && HAS_DIGIT_RE.test(trimmed)) {
      continue;
    }

    if (entity.label === "person") {
      const tokens = trimmed.split(/\s+/u);
      const last = tokens.at(-1)?.replace(/[.,;:!?]+$/u, "").toLowerCase();
      if (tokens.length > 1 && last && PERSON_TRAILING_NOUNS.has(last)) {
        continue;
      }
    }

    if (
      (entity.label === "person" || entity.label === "organization") &&
      roles.has(trimmed.toLowerCase())
    ) {
      continue;
    }

    // Reject long address entities that look like prose:
    // no digits, no postal code, no known address
    // component (street abbreviations, etc.).
    if (
      entity.label === "address" &&
      trimmed.length > 40 &&
      !POSTAL_CODE_RE.test(trimmed) &&
      !HAS_DIGIT_RE.test(trimmed) &&
      !ADDRESS_COMPONENTS_RE.test(trimmed) &&
      !JURISDICTION_RE.test(trimmed)
    ) {
      continue;
    }

    // Reject ANY trigger-sourced address without digits
    // and without a known street-type word. Catches
    // non-address text like "Nejsme plátci DPH !".
    // Exempt jurisdiction patterns ("State of ...",
    // "Commonwealth of ...") which are valid addresses
    // without digits.
    if (
      entity.label === "address" &&
      entity.source === "trigger" &&
      !HAS_DIGIT_RE.test(trimmed) &&
      !ADDRESS_COMPONENTS_RE.test(trimmed) &&
      !JURISDICTION_RE.test(trimmed)
    ) {
      continue;
    }

    if (entity.label === "address" && SIGNING_CLAUSE_ADDRESS_RE.test(trimmed)) {
      continue;
    }

    filtered.push(entity);
  }

  return filtered;
};
