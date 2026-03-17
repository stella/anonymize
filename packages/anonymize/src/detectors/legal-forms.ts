/**
 * Legal form detection for company/organization names.
 *
 * Detects company names by finding legal form suffixes
 * (s.r.o., GmbH, a.s., etc.) and extending backwards
 * to capture preceding capitalised words.
 *
 * Data-driven: legal forms are loaded from the optional
 * @stll/anonymize-data package. Falls back to an empty
 * set if not installed.
 */

import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

const UPPER =
  "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑ\\u0130";
const LOWER =
  "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñ\\u0131";
const CAP_WORD = `[${UPPER}][${LOWER}${UPPER}]+`;
/** Any word (upper or lowercase start, 2+ chars). */
const ANY_WORD = `[${UPPER}${LOWER}][${LOWER}${UPPER}]+`;

/**
 * Roman numerals that some jurisdictions use as legal
 * forms (e.g., Romania "II", "IF"). Filter these out
 * to avoid matching "Článek II", "Příloha III", etc.
 */
const ROMAN_NUMERAL_RE = /^[IVXLCDM]+$/;

const escapeForRegex = (form: string): string =>
  form
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/\\\./g, "\\.\\s*");

const isShortForm = (form: string): boolean =>
  form.replace(/[.\s]/g, "").length <= 3 &&
  !form.includes(" ");

const buildPattern = (
  forms: string[],
  requireCapBefore: boolean,
): RegExp | null => {
  if (forms.length === 0) {
    return null;
  }

  const sorted = forms.toSorted(
    (a, b) => b.length - a.length,
  );
  const alt = sorted.map(escapeForRegex).join("|");
  // First word must be capitalised; subsequent words
  // can be lowercase (Czech: "Pražské služby, a.s.",
  // "Rosa rodinné centrum, z.s.").
  const prefix =
    `(?:${CAP_WORD})` +
    `(?:[\\s&,.-]{1,4}(?:${ANY_WORD})){0,4}`;
  const separator = requireCapBefore
    ? `(?:\\s+|,\\s*)`
    : `\\s+`;

  return new RegExp(
    `${prefix}${separator}(?:${alt})(?![${LOWER}])`,
    "g",
  );
};

type CompiledPatterns = {
  longRe: RegExp | null;
  shortRe: RegExp | null;
};

let cached: CompiledPatterns | null = null;

const loadPatterns =
  async (): Promise<CompiledPatterns> => {
    if (cached) {
      return cached;
    }

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
      // Data package not installed; no legal forms
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

    cached = {
      longRe: buildPattern(
        allForms.filter((f) => !isShortForm(f)),
        false,
      ),
      shortRe: buildPattern(
        allForms.filter(isShortForm),
        true,
      ),
    };

    return cached;
  };

/**
 * Detect organization entities by legal form suffixes.
 */
export const detectLegalFormEntities = async (
  fullText: string,
): Promise<Entity[]> => {
  const { longRe, shortRe } = await loadPatterns();
  const results: Entity[] = [];

  for (const re of [longRe, shortRe]) {
    if (!re) {
      continue;
    }
    re.lastIndex = 0;

    for (
      let match = re.exec(fullText);
      match !== null;
      match = re.exec(fullText)
    ) {
      const raw = match[0];
      // Trim trailing whitespace/newlines that the
      // regex may have captured
      const text = raw.trimEnd();
      if (text.length < 5) {
        continue;
      }

      // Reject matches that span across paragraphs
      // (newline in the middle = not a single entity)
      if (text.includes("\n")) {
        continue;
      }

      // Reject matches where the "legal form" suffix is
      // actually a Roman numeral (II, III, IV, etc.)
      const lastSpace = text.lastIndexOf(" ");
      const suffix = lastSpace !== -1
        ? text.slice(lastSpace + 1).replace(/[.,]/g, "")
        : "";
      if (
        suffix.length > 0 &&
        ROMAN_NUMERAL_RE.test(suffix)
      ) {
        continue;
      }

      results.push({
        start: match.index,
        end: match.index + text.length,
        label: "organization",
        text,
        score: 0.9,
        source: DETECTION_SOURCES.LEGAL_FORM,
      });
    }
  }

  return results;
};
