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
 *
 * Uses a char-code lookup (`Map<number, number>`) and
 * `Uint16Array` instead of 7 sequential `replaceAll`
 * calls. For a 50 KB document this eliminates ~350 KB
 * of intermediate string allocations.
 *
 * When no replaceable characters are present (common
 * for plain-text inputs), a fast-path scan returns the
 * original string without any allocation. When special
 * characters exist, the string is scanned twice: once
 * to detect, once to build the replacement array.
 */

const REPLACEMENTS: readonly [number, number][] = [
  [0x00a0, 0x0020], // NBSP → space
  [0x2007, 0x0020], // figure space → space
  [0x202f, 0x0020], // narrow NBSP → space
  [0x2013, 0x002d], // en-dash → hyphen
  [0x2014, 0x002d], // em-dash → hyphen
  [0x201c, 0x0022], // left smart quote → "
  [0x201d, 0x0022], // right smart quote → "
];

const CHAR_MAP = new Map<number, number>(REPLACEMENTS);

/** Chunk size for `String.fromCharCode` to avoid
 *  hitting the call-stack limit on very large strings. */
const CHUNK_SIZE = 8192;

export const normalizeForSearch = (
  text: string,
): string => {
  // Fast path: skip allocation when nothing to replace.
  let hasSpecial = false;
  for (let i = 0; i < text.length; i++) {
    if (CHAR_MAP.has(text.charCodeAt(i))) {
      hasSpecial = true;
      break;
    }
  }
  if (!hasSpecial) return text;

  // Second pass: build output via Uint16Array.
  const len = text.length;
  const codes = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    codes[i] = CHAR_MAP.get(code) ?? code;
  }

  // Convert in chunks to avoid stack overflow on
  // spread of large arrays.
  if (len <= CHUNK_SIZE) {
    return String.fromCharCode(...codes);
  }

  let result = "";
  for (let offset = 0; offset < len; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, len);
    result += String.fromCharCode(
      ...codes.subarray(offset, end),
    );
  }
  return result;
};
