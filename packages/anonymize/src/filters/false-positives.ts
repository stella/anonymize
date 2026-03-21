import type { Entity } from "../types";

const TEMPLATE_PLACEHOLDER_RE =
  /^(?:\.{3,}|_{3,}|\[[\w\s]+\]|\{[\w\s]+\})$/;
// Section/clause numbers: "§ 3", "3.2.1", "12." but NOT
// dates like "4.3.2026" or long digit strings like IČO.
// A section number has 1-3 digit groups of 1-3 digits each,
// never ending with a 4-digit group (that's a year).
const SECTION_NUMBER_RE =
  /^(?:§\s*)?\d{1,3}(?:\.\d{1,3}){0,4}\.?$/;
const STANDALONE_YEAR_RE = /^(?:19|20)\d{2}$/;

// ── Generic roles (lazy-loaded from JSON) ────────────

let _genericRoles: ReadonlySet<string> | null = null;
let _genericRolesPromise:
  | Promise<ReadonlySet<string>>
  | null = null;

/**
 * Load generic-roles.json and cache the result.
 * Must be awaited during pipeline init so the sync
 * accessor is populated before filterFalsePositives
 * runs.
 */
export const loadGenericRoles =
  (): Promise<ReadonlySet<string>> => {
    if (_genericRolesPromise) return _genericRolesPromise;
    _genericRolesPromise = (async () => {
      try {
        const mod: {
          default?: { roles?: string[] };
        } = await import(
          "@stll/anonymize-data/config/generic-roles.json"
        );
        const set: ReadonlySet<string> = new Set(
          mod.default?.roles ?? [],
        );
        _genericRoles = set;
        return set;
      } catch {
        const empty: ReadonlySet<string> = new Set();
        _genericRoles = empty;
        return empty;
      }
    })();
    return _genericRolesPromise;
  };

const EMPTY_GENERIC_ROLES: ReadonlySet<string> =
  new Set();

/** Sync accessor — returns empty set before init. */
const getGenericRoles = (): ReadonlySet<string> =>
  _genericRoles ?? EMPTY_GENERIC_ROLES;

/**
 * Filter out entities that are likely false positives:
 * template placeholders, clause/section numbers,
 * standalone years, and generic legal role terms.
 *
 * Runs as a post-processing step after all detection
 * layers have merged.
 */
export const filterFalsePositives = (entities: Entity[]): Entity[] => {
  const filtered: Entity[] = [];

  for (const entity of entities) {
    const trimmed = entity.text.trim();

    if (TEMPLATE_PLACEHOLDER_RE.test(trimmed)) {
      continue;
    }
    // Section numbers (§ 3, 3.2.1, 12.) are false
    // positives unless they were captured by a trigger
    // phrase (e.g., "č.p. 92" is an address, not a
    // section number).
    if (
      SECTION_NUMBER_RE.test(trimmed) &&
      entity.source !== "trigger"
    ) {
      continue;
    }
    if (STANDALONE_YEAR_RE.test(trimmed)) {
      continue;
    }

    if (
      (entity.label === "person" || entity.label === "organization") &&
      getGenericRoles().has(trimmed.toLowerCase())
    ) {
      continue;
    }

    filtered.push(entity);
  }

  return filtered;
};
