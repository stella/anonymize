const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const BLOCK_BREAK_RE =
  /<\/(?:p|div|tr|h[1-6]|li|blockquote|pre)>|<br\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** Largest valid Unicode code point (U+10FFFF). */
const MAX_CODE_POINT = 0x10_ff_ff;

const decodeNumeric = (codePoint: number, fallback: string): string => {
  // String.fromCodePoint throws on NaN (malformed like `&#abc;`) and
  // on out-of-range values (e.g. `&#x110000;`); leave the source intact.
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_CODE_POINT
  ) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
};

const decodeEntities = (text: string): string =>
  text.replaceAll(/&(#x?[\da-f]+|[a-z]+);/gi, (match, body: string): string => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return decodeNumeric(Number.parseInt(body.slice(2), 16), match);
    }
    if (body.startsWith("#")) {
      return decodeNumeric(Number.parseInt(body.slice(1), 10), match);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });

/**
 * Minimal HTML-to-text conversion for EDGAR exhibits:
 * keeps block boundaries as newlines, decodes common
 * entities, collapses whitespace.
 */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replaceAll(SCRIPT_STYLE_RE, " ")
      .replaceAll(COMMENT_RE, " ")
      .replaceAll(BLOCK_BREAK_RE, "\n")
      .replaceAll(TAG_RE, " "),
  )
    .replaceAll(/[^\S\n]+/g, " ")
    .replaceAll(/ ?\n ?/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

const HTML_SNIFF_RE = /<(?:html|head|body|div|p|table|font|span)[\s>]/i;
const SNIFF_WINDOW = 4096;

export const looksLikeHtml = (text: string): boolean =>
  HTML_SNIFF_RE.test(text.slice(0, SNIFF_WINDOW));
