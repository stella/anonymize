/**
 * Centralized Unicode character equivalence groups.
 *
 * Loads char-groups.json from @stll/anonymize-data and
 * provides helpers to build regex character classes that
 * match all typographic variants of a character type
 * (dashes, spaces, quotes, etc.).
 *
 * The JSON is statically imported so the bundler inlines
 * it, avoiding a runtime require() that breaks browsers.
 */

import charGroupsJson from "@stll/anonymize-data/config/char-groups.json";

type CharEntry = {
  char: string;
  name: string;
  code: string;
};

type CharGroup = {
  description: string;
  chars: readonly CharEntry[];
};

type CharGroupsConfig = {
  _comment: string;
  groups: Record<string, CharGroup>;
};

/** Chars that need escaping inside a regex char class. */
const REGEX_CLASS_SPECIAL = /[\\\]^-]/;

const escapeForCharClass = (ch: string): string =>
  REGEX_CLASS_SPECIAL.test(ch) ? `\\${ch}` : ch;

// SAFETY: JSON shape matches CharGroupsConfig by contract
// with @stll/anonymize-data.
const config = charGroupsJson as CharGroupsConfig;

/**
 * Get the raw characters for a named group.
 * Throws if the group does not exist.
 */
export const charSet = (group: string): readonly string[] => {
  const g = config.groups[group];
  if (!g) {
    throw new Error(`Unknown char group: "${group}"`);
  }
  return g.chars.map((entry) => entry.char);
};

/**
 * Build a regex character class string for a named
 * group. E.g., charClass("dash") returns a string
 * like "[-\u2013\u2014\u2010\u2011\u2212\u2043]".
 *
 * The hyphen-minus is placed first so it is treated
 * as a literal, not a range indicator.
 */
export const charClass = (group: string): string => {
  const chars = charSet(group);
  // Place hyphen-minus first to avoid range issues.
  const sorted = [...chars].sort((a, b) => {
    if (a === "-") return -1;
    if (b === "-") return 1;
    return a.localeCompare(b);
  });
  const escaped = sorted.map(escapeForCharClass);
  return `[${escaped.join("")}]`;
};

/**
 * Return the inner content of a character class (without
 * the surrounding brackets). Useful for embedding a group
 * inside a larger character class, e.g.:
 *   `[\\s&,.${charClassInner("dash")}]`
 */
export const charClassInner = (group: string): string => {
  const chars = charSet(group);
  const sorted = [...chars].sort((a, b) => {
    if (a === "-") return -1;
    if (b === "-") return 1;
    return a.localeCompare(b);
  });
  return sorted.map(escapeForCharClass).join("");
};

/**
 * Build a regex alternation pattern for a named group.
 * Unlike charClass, this uses (?:a|b|c) syntax which
 * is useful when chars need individual escaping or
 * when embedding in complex patterns.
 */
export const charPattern = (group: string): string => {
  const chars = charSet(group);
  // SAFETY: length === 1 guarantees index 0 exists.
  if (chars.length === 1) return chars[0]!;
  const escaped = chars.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(?:${escaped.join("|")})`;
};

// ── Pre-built constants for common groups ──────

/** Regex char class matching all dash variants. */
export const DASH = charClass("dash");

/**
 * Inner content of the dash char class (no brackets).
 * For embedding inside a larger character class:
 *   `[\\s&,.${DASH_INNER}]`
 */
export const DASH_INNER = charClassInner("dash");

/** Regex char class matching all space variants. */
export const SPACE = charClass("space");

/** Regex char class matching all double-quote variants. */
export const QUOTE_DOUBLE = charClass("quote-double");

/** Regex char class matching all single-quote variants. */
export const QUOTE_SINGLE = charClass("quote-single");

/** Regex char class matching all slash variants. */
export const SLASH = charClass("slash");

/** Regex char class matching all dot variants. */
export const DOT = charClass("dot");

/** Regex char class matching all colon variants. */
export const COLON = charClass("colon");
