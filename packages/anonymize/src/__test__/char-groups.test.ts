import { describe, expect, test } from "bun:test";
import {
  charClass,
  charClassInner,
  charPattern,
  charSet,
  DASH,
  DASH_INNER,
  SPACE,
  QUOTE_DOUBLE,
  QUOTE_SINGLE,
  SLASH,
  DOT,
  COLON,
} from "../util/char-groups";

describe("charSet", () => {
  test("returns at least 2 entries per group", () => {
    const groups = [
      "dash",
      "space",
      "quote-double",
      "quote-single",
      "dot",
      "slash",
      "colon",
      "comma",
    ];
    for (const group of groups) {
      expect(charSet(group).length).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  test("throws on unknown group", () => {
    expect(() => charSet("nonexistent")).toThrow(
      /Unknown char group/,
    );
  });

  test("dash group contains ASCII hyphen", () => {
    expect(charSet("dash")).toContain("-");
  });

  test("dash group contains en-dash", () => {
    expect(charSet("dash")).toContain("\u2013");
  });

  test("dash group contains em-dash", () => {
    expect(charSet("dash")).toContain("\u2014");
  });
});

describe("charClass", () => {
  test("returns bracketed character class", () => {
    const cls = charClass("dash");
    expect(cls.startsWith("[")).toBe(true);
    expect(cls.endsWith("]")).toBe(true);
  });

  test("places hyphen-minus first", () => {
    const cls = charClass("dash");
    // After opening bracket, first char (possibly
    // escaped) should be the hyphen-minus.
    expect(cls.startsWith("[\\-")).toBe(true);
  });

  test("produced regex is valid", () => {
    const groups = [
      "dash",
      "space",
      "quote-double",
      "slash",
      "dot",
      "colon",
    ];
    for (const group of groups) {
      expect(
        () => new RegExp(charClass(group)),
      ).not.toThrow();
    }
  });
});

describe("charClassInner", () => {
  test("returns content without brackets", () => {
    const inner = charClassInner("dash");
    expect(inner.startsWith("[")).toBe(false);
    expect(inner.endsWith("]")).toBe(false);
  });

  test("can be embedded in larger class", () => {
    const inner = charClassInner("dash");
    const re = new RegExp(`[\\s${inner}]`);
    expect(re.test("-")).toBe(true);
    expect(re.test("\u2013")).toBe(true);
    expect(re.test(" ")).toBe(true);
  });
});

describe("charPattern", () => {
  test("returns alternation for multi-char groups", () => {
    const pat = charPattern("dash");
    expect(pat.startsWith("(?:")).toBe(true);
  });

  test("produced regex matches all group chars", () => {
    const chars = charSet("dash");
    const re = new RegExp(charPattern("dash"));
    for (const ch of chars) {
      expect(re.test(ch)).toBe(true);
    }
  });
});

describe("pre-built constants", () => {
  test("DASH matches all dash variants", () => {
    const re = new RegExp(DASH);
    const expected = [
      "-",
      "\u2013",
      "\u2014",
      "\u2010",
      "\u2011",
      "\u2212",
      "\u2043",
    ];
    for (const ch of expected) {
      expect(re.test(ch)).toBe(true);
    }
    expect(re.test("a")).toBe(false);
  });

  test("DASH_INNER can embed in larger class", () => {
    const re = new RegExp(`[\\s&,.${DASH_INNER}]`);
    expect(re.test("-")).toBe(true);
    expect(re.test("\u2014")).toBe(true);
    expect(re.test("&")).toBe(true);
    expect(re.test("z")).toBe(false);
  });

  test("SPACE matches all space variants", () => {
    const re = new RegExp(SPACE);
    expect(re.test(" ")).toBe(true);
    expect(re.test("\u00A0")).toBe(true);
    expect(re.test("\u202F")).toBe(true);
    expect(re.test("a")).toBe(false);
  });

  test("QUOTE_DOUBLE matches all double quotes", () => {
    const re = new RegExp(QUOTE_DOUBLE);
    expect(re.test('"')).toBe(true);
    expect(re.test("\u201C")).toBe(true);
    expect(re.test("\u201D")).toBe(true);
    expect(re.test("\u00AB")).toBe(true);
    expect(re.test("a")).toBe(false);
  });

  test("QUOTE_SINGLE matches all single quotes", () => {
    const re = new RegExp(QUOTE_SINGLE);
    expect(re.test("'")).toBe(true);
    expect(re.test("\u2018")).toBe(true);
    expect(re.test("\u2019")).toBe(true);
    expect(re.test("a")).toBe(false);
  });

  test("SLASH matches all slash variants", () => {
    const re = new RegExp(SLASH);
    expect(re.test("/")).toBe(true);
    expect(re.test("\u2044")).toBe(true);
    expect(re.test("a")).toBe(false);
  });

  test("DOT matches all dot variants", () => {
    const re = new RegExp(DOT);
    expect(re.test(".")).toBe(true);
    expect(re.test("\u00B7")).toBe(true);
    expect(re.test("a")).toBe(false);
  });

  test("COLON matches all colon variants", () => {
    const re = new RegExp(COLON);
    expect(re.test(":")).toBe(true);
    expect(re.test("\u2236")).toBe(true);
    expect(re.test("a")).toBe(false);
  });
});

describe("regex integration", () => {
  test("currency dash notation matches", () => {
    // Pattern from regex.ts: decimal part with dashes
    const re = new RegExp(
      `\\d+,${DASH}{1,2}`,
    );
    expect(re.test("100,-")).toBe(true);
    expect(re.test("100,\u2014")).toBe(true);
    expect(re.test("100,--")).toBe(true);
    expect(re.test("100,\u2013\u2014")).toBe(true);
  });

  test("postal code dash pattern matches", () => {
    const re = new RegExp(
      `\\d{5}\\s*${DASH}?\\s*$`,
    );
    expect(re.test("16300 ")).toBe(true);
    expect(re.test("16300 - ")).toBe(true);
    expect(re.test("16300 \u2013 ")).toBe(true);
  });
});
