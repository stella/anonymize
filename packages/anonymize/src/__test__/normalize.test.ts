import { describe, expect, test } from "bun:test";
import { normalizeForSearch } from "../util/normalize";

describe("normalizeForSearch", () => {
  test("replaces NBSP with space", () => {
    expect(normalizeForSearch("hello\u00a0world")).toBe(
      "hello world",
    );
  });

  test("replaces figure space with space", () => {
    expect(normalizeForSearch("1\u2007000")).toBe("1 000");
  });

  test("replaces narrow NBSP with space", () => {
    expect(normalizeForSearch("a\u202fb")).toBe("a b");
  });

  test("replaces en-dash with hyphen", () => {
    expect(normalizeForSearch("2020\u20132024")).toBe(
      "2020-2024",
    );
  });

  test("replaces em-dash with hyphen", () => {
    expect(normalizeForSearch("a\u2014b")).toBe("a-b");
  });

  test("replaces smart quotes with ASCII quotes", () => {
    expect(
      normalizeForSearch("\u201chello\u201d"),
    ).toBe('"hello"');
  });

  test("returns plain text as-is (fast path)", () => {
    const plain = "no special characters here";
    expect(normalizeForSearch(plain)).toBe(plain);
  });

  test("handles empty string", () => {
    expect(normalizeForSearch("")).toBe("");
  });

  test("normalizes mixed content correctly", () => {
    // Czech legal text with NBSP, smart quotes, en-dash
    const input =
      "\u201cSmlouva\u00a0\u010d.\u202f42\u201d " +
      "\u2013\u00a0viz\u00a0p\u0159\u00edloha";
    const expected =
      '"Smlouva \u010d. 42" ' +
      "- viz p\u0159\u00edloha";
    expect(normalizeForSearch(input)).toBe(expected);
  });
});
