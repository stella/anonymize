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

const replacementCode = (code: number): number => {
  switch (code) {
    case 0x00a0:
    case 0x2007:
    case 0x202f:
      return 0x0020;
    case 0x2013:
    case 0x2014:
      return 0x002d;
    case 0x201c:
    case 0x201d:
      return 0x0022;
    default:
      return code;
  }
};

/** Chunk size for `String.fromCharCode` to avoid
 *  hitting the call-stack limit on very large strings. */
const CHUNK_SIZE = 8192;

export const normalizeForSearch = (text: string): string => {
  // Fast path: skip allocation when nothing to replace.
  let hasSpecial = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (replacementCode(code) !== code) {
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
    codes[i] = replacementCode(code);
  }

  // Convert in chunks to avoid stack overflow on
  // spread of large arrays.
  if (len <= CHUNK_SIZE) {
    return String.fromCharCode(...codes);
  }

  let result = "";
  for (let offset = 0; offset < len; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, len);
    result += String.fromCharCode(...codes.subarray(offset, end));
  }
  return result;
};
