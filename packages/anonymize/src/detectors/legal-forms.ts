/**
 * Legal form detection for company/organization names.
 *
 * Detects company names by finding legal form suffixes
 * (s.r.o., GmbH, a.s., etc.) and extending backwards
 * to capture preceding capitalised words.
 *
 * Exports pattern definitions for the unified builder
 * and a match processor for post-processing.
 */

import type { Match } from "@stll/text-search";

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

// ── Pattern builder for unified search ──────────────

/**
 * Build legal form regex pattern strings.
 * Returns an array of regex strings for the unified
 * TextSearch builder. Empty if data package is not
 * installed.
 */
export const buildLegalFormPatterns = async (): Promise<
  string[]
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
    return [];
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

  return patterns;
};

// ── Match processor ─────────────────────────────────

/**
 * Process legal form matches from the unified search.
 * Receives all matches; filters to the legal forms
 * slice via sliceStart/sliceEnd.
 */
export const processLegalFormMatches = (
  allMatches: Match[],
  sliceStart: number,
  sliceEnd: number,
): Entity[] => {
  const results: Entity[] = [];

  for (const match of allMatches) {
    const idx = match.pattern;
    if (idx < sliceStart || idx >= sliceEnd) {
      continue;
    }

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
