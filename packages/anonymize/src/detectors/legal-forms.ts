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
const CAP_WORD =
  `(?:[${UPPER}]{2,}|[${UPPER}][${LOWER}${UPPER}]+)`;
// ANY_WORD: mixed-case word OR short all-caps token
// (2-3 chars, e.g. "CZ" in "Metrostav CZ s.r.o.")
const ANY_WORD =
  `(?:[${UPPER}${LOWER}][${LOWER}${UPPER}]+` +
  `|[${UPPER}]{2,3})`;
// All-caps word: 2+ uppercase letters, no lowercase.
// For company names like "EAGLES BRNO", max 3 words.
const ALLCAP_WORD = `[${UPPER}]{2,}`;

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
  // Allow lowercase connectors between name words:
  // "a" (Czech/SK), "and", "und", "et", "&", "e"
  const CONNECTOR = `(?:[\\s&,.-]{1,4}|\\s+(?:a|and|und|et|e|y|i)\\s+)`;
  // Czech state enterprise names can be 7+ words:
  // "Národní agentura pro komunikační a informační
  // technologie, s. p." — need generous limit.
  const prefix =
    `(?:${CAP_WORD})` +
    `(?:${CONNECTOR}(?:${ANY_WORD})){0,7}`;
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

  // All-caps company names: "EAGLES BRNO, z.s."
  // Up to 3 all-caps words before any legal form.
  // Uses all forms (both long and short).
  const allcapPrefix =
    `(?:${ALLCAP_WORD})` +
    `(?:[\\s&,.-]{1,4}(?:${ALLCAP_WORD})){0,2}`;
  const allcapAlt = allForms
    .toSorted((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|");
  patterns.push(
    `${allcapPrefix}(?:\\s+|,\\s*)` +
      `(?:${allcapAlt})(?![${LOWER}])`,
  );

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
  fullText?: string,
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

    // Reject all-caps matches only if the entire
    // surrounding line is all-caps (section headings
    // like "KUPNÍ SMLOUVA"). If only the company name
    // is all-caps ("uzavřená s EAGLES BRNO, z.s."),
    // keep it — max 3 all-caps words are allowed.
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
    const isAllCapsMatch =
      prefixPart.length > 2 &&
      prefixPart === prefixPart.toUpperCase();

    if (isAllCapsMatch && fullText) {
      // Check: is the surrounding line also all-caps?
      const lineStart = fullText.lastIndexOf(
        "\n",
        match.start,
      );
      const lineEnd = fullText.indexOf(
        "\n",
        match.end,
      );
      const line = fullText.slice(
        lineStart + 1,
        lineEnd === -1 ? fullText.length : lineEnd,
      );
      const lineLetters = line.replace(
        /[^a-zA-ZÀ-ž]/g,
        "",
      );
      const upperCount = [...lineLetters].filter(
        (c) => c === c.toUpperCase(),
      ).length;
      const lineIsAllCaps =
        lineLetters.length > 5 &&
        upperCount / lineLetters.length >= 0.95;
      if (lineIsAllCaps) {
        // Entire line is all-caps → heading, skip
        continue;
      }
      // Only the company name is all-caps → keep it
      // (but limit to 3 words in prefix)
      const wordCount =
        prefixPart.length > 0
          ? text
              .slice(0, prefixEnd > 0 ? prefixEnd : text.length)
              .trim()
              .split(/\s+/).length
          : 0;
      if (wordCount > 3) {
        continue;
      }
    } else if (isAllCapsMatch) {
      // No fullText available — fall back to rejecting
      continue;
    }

    // Reject Roman numeral suffixes
    const lastSpace = text.lastIndexOf(" ");
    const rawSuffix =
      lastSpace !== -1
        ? text.slice(lastSpace + 1)
        : "";
    const suffixClean = rawSuffix.replace(/[.,]/g, "");
    if (
      suffixClean.length > 0 &&
      ROMAN_NUMERAL_RE.test(suffixClean)
    ) {
      continue;
    }

    // Short ASCII-only suffixes (NA, PA, LP, PC) are
    // US-specific. Reject if the prefix contains non-
    // ASCII chars (Czech/Slovak diacritics) — a US
    // legal entity wouldn't have "ÚČASTI MSP NA".
    // Test for dots in the raw suffix (before dot
    // stripping) to protect Czech dotted forms like
    // "a.s." and "k.s.".
    if (
      suffixClean.length <= 2 &&
      !/\./.test(rawSuffix) &&
      /[^\x00-\x7F]/.test(
        text.slice(
          0,
          lastSpace !== -1 ? lastSpace : text.length,
        ),
      )
    ) {
      continue;
    }

    // Definitive legal forms (s.r.o., a.s., GmbH, etc.)
    // get score 0.95 to beat person names in dedup.
    results.push({
      start: match.start,
      end: match.start + text.length,
      label: "organization",
      text,
      score: 0.95,
      source: DETECTION_SOURCES.LEGAL_FORM,
    });
  }

  return results;
};
