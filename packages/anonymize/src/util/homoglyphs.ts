/**
 * Fold Cyrillic and Greek lookalike characters to their
 * Latin equivalents for stop-list lookups.
 *
 * Adversarial inputs and OCR artifacts can produce
 * mixed-script tokens like "mаnager" (with a Cyrillic
 * `а`) that visually read as Latin but bypass a Latin-
 * keyed stop-list. Folding before lookup closes that
 * gap.
 *
 * Only used inside stop-list / false-positive checks —
 * never on stored entity text. Genuine Cyrillic words
 * never pass through this path. Replacements are same-
 * length (single code unit → single code unit), so
 * offsets remain valid if a caller needs them.
 *
 * Mappings are restricted to letters that are visually
 * indistinguishable from Latin in common fonts. Glyphs
 * whose lowercase form does not resemble Latin (e.g.
 * Cyrillic lowercase `в`, which looks nothing like
 * lowercase `b`) are omitted from the lowercase
 * section even when their uppercase form is included.
 */

const REPLACEMENTS: readonly [number, number][] = [
  // ── Cyrillic uppercase ───────────────────────────────
  [0x0410, 0x0041], // А → A
  [0x0412, 0x0042], // В → B
  [0x0415, 0x0045], // Е → E
  [0x041a, 0x004b], // К → K
  [0x041c, 0x004d], // М → M
  [0x041d, 0x0048], // Н → H
  [0x041e, 0x004f], // О → O
  [0x0420, 0x0050], // Р → P
  [0x0421, 0x0043], // С → C
  [0x0422, 0x0054], // Т → T
  [0x0425, 0x0058], // Х → X
  // ── Cyrillic lowercase ───────────────────────────────
  [0x0430, 0x0061], // а → a
  [0x0435, 0x0065], // е → e
  [0x043e, 0x006f], // о → o
  [0x0440, 0x0070], // р → p
  [0x0441, 0x0063], // с → c
  [0x0443, 0x0079], // у → y
  [0x0445, 0x0078], // х → x
  // ── Other Cyrillic (Ukrainian/Belarusian/Serbian) ────
  [0x0456, 0x0069], // і → i
  [0x0458, 0x006a], // ј → j
  // ── Greek uppercase ──────────────────────────────────
  [0x0391, 0x0041], // Α → A
  [0x0392, 0x0042], // Β → B
  [0x0395, 0x0045], // Ε → E
  [0x0397, 0x0048], // Η → H
  [0x0399, 0x0049], // Ι → I
  [0x039a, 0x004b], // Κ → K
  [0x039c, 0x004d], // Μ → M
  [0x039d, 0x004e], // Ν → N
  [0x039f, 0x004f], // Ο → O
  [0x03a1, 0x0050], // Ρ → P
  [0x03a4, 0x0054], // Τ → T
  [0x03a5, 0x0059], // Υ → Y
  [0x03a7, 0x0058], // Χ → X
  [0x0396, 0x005a], // Ζ → Z
  // ── Greek lowercase ──────────────────────────────────
  [0x03b1, 0x0061], // α → a
  [0x03ba, 0x006b], // κ → k
  [0x03bf, 0x006f], // ο → o
  [0x03c1, 0x0070], // ρ → p
];

const CHAR_MAP = new Map<number, number>(REPLACEMENTS);

/** Chunk size for `String.fromCharCode` to avoid hitting
 *  the call-stack limit on very large strings. */
const CHUNK_SIZE = 8192;

export const normalizeHomoglyphs = (text: string): string => {
  let hasSpecial = false;
  for (let i = 0; i < text.length; i++) {
    if (CHAR_MAP.has(text.charCodeAt(i))) {
      hasSpecial = true;
      break;
    }
  }
  if (!hasSpecial) return text;

  const len = text.length;
  const codes = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    codes[i] = CHAR_MAP.get(code) ?? code;
  }

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
