import { describe, expect, test } from "bun:test";

import { normalizeHomoglyphs } from "../util/homoglyphs";

describe("normalizeHomoglyphs", () => {
  test("returns plain ASCII unchanged (fast path)", () => {
    const plain = "manager";
    expect(normalizeHomoglyphs(plain)).toBe(plain);
  });

  test("folds Cyrillic lookalikes to Latin", () => {
    // "manager" with Cyrillic а (U+0430)
    expect(normalizeHomoglyphs("mаnager")).toBe("manager");
    // "company" with Cyrillic с (U+0441) and о (U+043E)
    expect(normalizeHomoglyphs("соmpany")).toBe("company");
  });

  test("folds Greek lookalikes to Latin", () => {
    // "Apple" with Greek Α (U+0391)
    expect(normalizeHomoglyphs("Αpple")).toBe("Apple");
    // Greek ο (U+03BF) inside "Acme corp"
    expect(normalizeHomoglyphs("cοrp")).toBe("corp");
  });

  test("preserves offsets — output length matches input", () => {
    const input = "CСCС";
    expect(normalizeHomoglyphs(input).length).toBe(input.length);
  });

  test("untouched code points stay put", () => {
    // Cyrillic Я (U+042F) has no Latin lookalike — leave it.
    expect(normalizeHomoglyphs("Я")).toBe("Я");
  });
});
