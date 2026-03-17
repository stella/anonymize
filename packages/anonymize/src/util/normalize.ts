/**
 * Normalize typographic variants for search matching.
 *
 * Legal documents (especially Czech/German) use
 * non-breaking spaces, smart quotes, and en/em dashes
 * that differ from their ASCII equivalents. Since all
 * replacements are same-length (single code unit →
 * single code unit), character offsets remain valid.
 *
 * Lives here (application layer) rather than in the
 * AC library: what to normalize is domain-specific.
 */

const NORMALIZE_MAP: readonly [string, string][] = [
  ["\u00a0", " "], // NBSP → space
  ["\u2007", " "], // figure space
  ["\u202f", " "], // narrow NBSP
  ["\u2013", "-"], // en-dash
  ["\u2014", "-"], // em-dash
  ["\u201c", '"'], // left smart quote
  ["\u201d", '"'], // right smart quote
];

export const normalizeForSearch = (
  text: string,
): string => {
  let result = text;
  for (const [from, to] of NORMALIZE_MAP) {
    result = result.replaceAll(from, to);
  }
  return result;
};
