/**
 * Legal form detection for company/organization names.
 *
 * Detects company names by finding legal form suffixes
 * (s.r.o., GmbH, a.s., etc.) and extending backwards
 * to capture preceding capitalised words.
 *
 * Uses @stll/regex-set for single-pass DFA scanning.
 * Data-driven: legal forms are loaded from the optional
 * @stll/anonymize-data package.
 */

import { RegexSet } from "@stll/regex-set";

import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

const UPPER =
  "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑ\\u0130";
const LOWER =
  "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñ\\u0131";
const CAP_WORD = `[${UPPER}][${LOWER}${UPPER}]+`;
const ANY_WORD = `[${UPPER}${LOWER}][${LOWER}${UPPER}]+`;

const ROMAN_NUMERAL_RE =
  /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

const escapeForRegex = (form: string): string =>
  form
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/\\\./g, "\\.\\s*");

const isShortForm = (form: string): boolean =>
  form.replace(/[.\s]/g, "").length <= 3 &&
  !form.includes(" ");

const buildPatternString = (
  forms: string[],
  requireCapBefore: boolean,
): string | null => {
  if (forms.length === 0) {
    return null;
  }

  const sorted = forms.toSorted(
    (a, b) => b.length - a.length,
  );
  const alt = sorted.map(escapeForRegex).join("|");
  const prefix =
    `(?:${CAP_WORD})` +
    `(?:[\\s&,.-]{1,4}(?:${ANY_WORD})){0,4}`;
  const separator = requireCapBefore
    ? `(?:\\s+|,\\s*)`
    : `\\s+`;

  return `${prefix}${separator}(?:${alt})(?![${LOWER}])`;
};

// ── Cached RegexSet ─────────────────────────────────

type CompiledSet = {
  rs: RegexSet;
  /** Pattern 0 = long forms, pattern 1 = short forms */
  patternCount: number;
};

let cachedPromise: Promise<CompiledSet | null> | null =
  null;

const loadSet = (): Promise<CompiledSet | null> => {
  if (cachedPromise) {
    return cachedPromise;
  }
  cachedPromise = buildSet();
  return cachedPromise;
};

const buildSet = async (): Promise<
  CompiledSet | null
> => {
  let data: Record<string, string[]> = {};

  try {
    const mod = await import(
      "@stll/anonymize-data/config/legal-forms.json"
    );
    // eslint-disable-next-line no-unsafe-type-assertion -- JSON module shape
    data = (
      mod as { default: Record<string, string[]> }
    ).default;
  } catch {
    return null;
  }

  const allForms: string[] = [];
  const seen = new Set<string>();

  for (const forms of Object.values(data)) {
    for (const form of forms) {
      const key = form.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allForms.push(form);
      }
    }
  }

  const patterns: string[] = [];

  const longPattern = buildPatternString(
    allForms.filter((f) => !isShortForm(f)),
    false,
  );
  if (longPattern) {
    patterns.push(longPattern);
  }

  const shortPattern = buildPatternString(
    allForms.filter(isShortForm),
    true,
  );
  if (shortPattern) {
    patterns.push(shortPattern);
  }

  if (patterns.length === 0) {
    return null;
  }

  return {
    rs: new RegexSet(patterns),
    patternCount: patterns.length,
  };
};

/**
 * Detect organization entities by legal form suffixes.
 * Uses @stll/regex-set for single-pass DFA scanning.
 */
export const detectLegalFormEntities = async (
  fullText: string,
): Promise<Entity[]> => {
  const set = await loadSet();
  if (!set) {
    return [];
  }

  const results: Entity[] = [];
  const matches = set.rs.findIter(fullText);

  for (const match of matches) {
    const text = match.text.trimEnd();
    if (text.length < 5) {
      continue;
    }

    if (text.includes("\n")) {
      continue;
    }

    // Reject all-caps matches (section headings)
    const prefixEnd =
      text.lastIndexOf(",") !== -1
        ? text.lastIndexOf(",")
        : text.lastIndexOf(" ");
    const prefixPart =
      prefixEnd > 0
        ? text
            .slice(0, prefixEnd)
            .replace(/[^a-zA-ZÀ-ž]/g, "")
        : text.replace(/[^a-zA-ZÀ-ž]/g, "");
    if (
      prefixPart.length > 2 &&
      prefixPart === prefixPart.toUpperCase()
    ) {
      continue;
    }

    // Reject Roman numeral suffixes
    const lastSpace = text.lastIndexOf(" ");
    const suffix =
      lastSpace !== -1
        ? text
            .slice(lastSpace + 1)
            .replace(/[.,]/g, "")
        : "";
    if (
      suffix.length > 0 &&
      ROMAN_NUMERAL_RE.test(suffix)
    ) {
      continue;
    }

    results.push({
      start: match.start,
      end: match.start + text.length,
      label: "organization",
      text,
      score: 0.9,
      source: DETECTION_SOURCES.LEGAL_FORM,
    });
  }

  return results;
};
