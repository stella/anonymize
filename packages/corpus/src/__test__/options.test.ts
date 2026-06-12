import { describe, expect, test } from "bun:test";

import { positiveIntegerOption } from "../options";

describe("positiveIntegerOption", () => {
  test("uses the fallback when the option is absent", () => {
    expect(
      positiveIntegerOption({ name: "limit", value: undefined, fallback: 25 }),
    ).toBe(25);
  });

  test("accepts positive integers", () => {
    expect(
      positiveIntegerOption({ name: "pages", value: "3", fallback: 1 }),
    ).toBe(3);
  });

  test("rejects malformed and non-positive values", () => {
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      expect(() =>
        positiveIntegerOption({ name: "limit", value, fallback: 25 }),
      ).toThrow("--limit must be a positive integer");
    }
  });
});
